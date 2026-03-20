import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";

class EvaluateTrialEligibility implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "evaluate_trial_eligibility",
      {
        description:
          "Evaluates the current patient's eligibility for a specific clinical trial by analyzing inclusion and exclusion criteria against their FHIR record. Returns a structured assessment with reasoning.",
        inputSchema: {
          nct_id: z
            .string()
            .describe(
              "ClinicalTrials.gov trial identifier e.g. NCT04179552",
            ),
        },
      },
      async ({ nct_id }) => {
        const fhirContext = FhirUtilities.getFhirContext(req);
        const patientId = FhirUtilities.getPatientIdIfContextExists(req);

        if (!fhirContext?.url || !patientId) {
          return McpUtilities.createTextResponse(
            "Missing required FHIR context headers.",
          );
        }

        const fhirServerUrl = fhirContext.url;
        const accessToken = fhirContext.token;

        const headers: Record<string, string> = {
          Accept: "application/fhir+json",
        };
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        try {
          // Fetch patient conditions
          const conditionsRes = await fetch(
            `${fhirServerUrl}/Condition?patient=${patientId}&clinical-status=active`,
            { headers },
          );
          if (!conditionsRes.ok) {
            return McpUtilities.createTextResponse(
              `Failed to fetch patient conditions: ${conditionsRes.status}`,
              { isError: true },
            );
          }
          const conditionsData = await conditionsRes.json();
          const conditions: string[] =
            conditionsData.entry?.map(
              (e: any) =>
                e.resource?.code?.coding?.[0]?.display ||
                e.resource?.code?.text,
            ).filter(Boolean) ?? [];

          // Fetch patient medications
          const medsRes = await fetch(
            `${fhirServerUrl}/MedicationRequest?patient=${patientId}&status=active`,
            { headers },
          );
          if (!medsRes.ok) {
            return McpUtilities.createTextResponse(
              `Failed to fetch patient medications: ${medsRes.status}`,
              { isError: true },
            );
          }
          const medsData = await medsRes.json();
          const medications: string[] =
            medsData.entry?.map(
              (e: any) =>
                e.resource?.medicationCodeableConcept?.coding?.[0]?.display ||
                e.resource?.medicationCodeableConcept?.text,
            ).filter(Boolean) ?? [];

          // Fetch patient demographics
          const patientRes = await fetch(
            `${fhirServerUrl}/Patient/${patientId}`,
            { headers },
          );
          if (!patientRes.ok) {
            return McpUtilities.createTextResponse(
              `Failed to fetch patient demographics: ${patientRes.status}`,
              { isError: true },
            );
          }
          const patientData = await patientRes.json();

          if (!patientData.birthDate) {
            return McpUtilities.createTextResponse(
              "Patient birth date not found.",
            );
          }

          const age =
            new Date().getFullYear() -
            new Date(patientData.birthDate).getFullYear();
          const sex = patientData.gender?.toLowerCase() || "unknown";

          // Fetch trial data
          const trialRes = await fetch(
            `https://clinicaltrials.gov/api/v2/studies/${nct_id}?format=json`,
          );

          if (!trialRes.ok) {
            if (trialRes.status === 404) {
              return McpUtilities.createTextResponse(
                `Trial ${nct_id} not found.`,
              );
            }
            return McpUtilities.createTextResponse(
              `Failed to fetch trial: ${trialRes.status}`,
              { isError: true },
            );
          }

          const trialData = await trialRes.json();
          const protocol = trialData.protocolSection;

          if (!protocol) {
            return McpUtilities.createTextResponse(
              "Trial protocol data not available.",
              { isError: true },
            );
          }

          const eligibility = protocol.eligibilityModule || {};
          const identification = protocol.identificationModule || {};

          const eligibilityCriteria = eligibility.eligibilityCriteria || "";
          const minAgeStr = eligibility.minimumAge || "0";
          const maxAgeStr = eligibility.maximumAge || "999";
          const trialSex = (eligibility.sex || "ALL").toUpperCase();

          const minAge = this._parseAge(minAgeStr);
          const maxAge = this._parseAge(maxAgeStr);

          // Split criteria into inclusion/exclusion
          const inclusionMatch = eligibilityCriteria.match(
            /Inclusion Criteria[:\s]*([\s\S]*?)(?=Exclusion Criteria|$)/i,
          );
          const exclusionMatch = eligibilityCriteria.match(
            /Exclusion Criteria[:\s]*([\s\S]*?)$/i,
          );

          const inclusionText = inclusionMatch?.[1] || eligibilityCriteria;
          const exclusionText = exclusionMatch?.[1] || "";

          // Perform checks
          const ageResult =
            age >= minAge && age <= maxAge
              ? "PASS"
              : age < minAge
                ? "FAIL (too young)"
                : "FAIL (too old)";

          const sexResult =
            trialSex === "ALL" ||
            trialSex === sex.toUpperCase() ||
            (trialSex === "FEMALE" && sex === "female") ||
            (trialSex === "MALE" && sex === "male")
              ? "PASS"
              : "FAIL";

          // Condition match check - fully dynamic, no hardcoded terms
          let conditionMatch = "NO CLEAR MATCH";
          const matchDetails: string[] = [];

          // DEBUG: Collect debug info
          const debugCleanedConditions: { original: string; cleaned: string; words: string[] }[] = [];

          // Helper to extract meaningful words (4+ chars to skip noise like "and", "the", "of")
          const extractWords = (text: string): string[] => {
            return text
              .toLowerCase()
              .split(/\s+/)
              .filter((w: string) => w.length >= 4 && /^[a-z]+$/.test(w));
          };

          const inclusionLower = inclusionText.toLowerCase();
          const inclusionWords = extractWords(inclusionText);

          for (const cond of conditions) {
            // Step 1: Clean condition dynamically
            let cleaned = cond.replace(/\s*\(.*?\)\s*/g, "").trim();
            cleaned = cleaned.replace(/\s+-\s+.*$/, "").trim();
            const cleanedLower = cleaned.toLowerCase();

            // Step 2: Extract meaningful words from cleaned condition
            const conditionWords = extractWords(cleaned);

            // DEBUG: Store cleaned condition and extracted words
            debugCleanedConditions.push({
              original: cond,
              cleaned: cleaned,
              words: conditionWords,
            });

            // Step 3: Check both directions dynamically
            // Direction A: Does inclusion text contain the whole cleaned condition?
            if (cleanedLower && inclusionLower.includes(cleanedLower)) {
              matchDetails.push(`Condition "${cond}" matched as phrase in inclusion criteria`);
              continue;
            }

            // Direction B: Does inclusion text contain any condition word?
            for (const condWord of conditionWords) {
              if (inclusionLower.includes(condWord)) {
                matchDetails.push(`Condition "${cond}" matched via word "${condWord}" in inclusion criteria`);
                break;
              }
            }

            // Direction C: Does condition contain any inclusion word?
            for (const inclWord of inclusionWords) {
              if (cleanedLower.includes(inclWord)) {
                matchDetails.push(`Condition "${cond}" matched via inclusion word "${inclWord}"`);
                break;
              }
            }
          }

          // Step 5: Set result based on matches found
          if (matchDetails.length > 0) {
            conditionMatch = `MATCH FOUND: ${matchDetails.join("; ")}`;
          }

          // Exclusion scan
          const exclusionFlags: string[] = [];
          const allTerms = [...conditions, ...medications];
          for (const term of allTerms) {
            if (
              term &&
              exclusionText.toLowerCase().includes(term.toLowerCase())
            ) {
              exclusionFlags.push(term);
            }
          }

          // Determine overall assessment
          let overall = "UNCERTAIN";
          if (ageResult === "PASS" && sexResult === "PASS") {
            if (exclusionFlags.length === 0 && matchDetails.length > 0) {
              overall = "LIKELY ELIGIBLE";
            } else if (exclusionFlags.length > 0) {
              overall = "LIKELY INELIGIBLE";
            }
          } else if (ageResult.startsWith("FAIL") || sexResult === "FAIL") {
            overall = "LIKELY INELIGIBLE";
          }

          // Identify data gaps
          const dataGaps: string[] = [];
          if (conditions.length === 0) dataGaps.push("No conditions on file");
          if (medications.length === 0)
            dataGaps.push("No medications on file");
          if (sex === "unknown") dataGaps.push("Sex not documented");

          // Build report
          const report = `
=== TRIAL INFO ===
NCT ID: ${identification.nctId || nct_id}
Title: ${identification.briefTitle || "Unknown"}

=== AGE ELIGIBILITY ===
Trial Range: ${minAgeStr} - ${maxAgeStr}
Patient Age: ${age}
Result: ${ageResult}

=== SEX ELIGIBILITY ===
Trial Requirement: ${trialSex}
Patient Sex: ${sex.toUpperCase()}
Result: ${sexResult}

=== CONDITION MATCH ===
Patient Conditions: ${conditions.length > 0 ? conditions.join(", ") : "None documented"}
Inclusion Criteria Match: ${conditionMatch}

=== EXCLUSION FLAGS ===
${exclusionFlags.length > 0 ? exclusionFlags.map((f) => `WARNING: "${f}" found in exclusion criteria`).join("\n") : "No exclusion flags detected"}

=== OVERALL ASSESSMENT ===
${overall}

=== DATA GAPS ===
${dataGaps.length > 0 ? dataGaps.join("\n") : "No significant gaps identified"}

=== DEBUG (TEMPORARY) ===
Raw Eligibility Criteria (first 500 chars):
${eligibilityCriteria.substring(0, 500)}

Cleaned Patient Conditions:
${debugCleanedConditions.map((c) => `  "${c.original}" -> "${c.cleaned}"`).join("\n")}

Extracted Words from Each Condition (>= 4 chars):
${debugCleanedConditions.map((c) => `  "${c.cleaned}": [${c.words.join(", ")}]`).join("\n")}

First 50 Words from Inclusion Criteria:
${inclusionWords.slice(0, 50).join(", ")}
`.trim();

          return McpUtilities.createTextResponse(report);
        } catch (error: any) {
          return McpUtilities.createTextResponse(
            `Error evaluating trial eligibility: ${error?.message ?? String(error)}\nStack: ${error?.stack ?? "no stack"}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _parseAge(ageStr: string | undefined): number {
    if (!ageStr) return 0;
    const match = ageStr.match(/(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : 0;
  }
}

export const EvaluateTrialEligibilityInstance = new EvaluateTrialEligibility();
