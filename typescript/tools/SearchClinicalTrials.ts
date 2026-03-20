import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";

interface TrialResult {
  nctId: string;
  title: string;
  phase: string;
  status: string;
  eligibilitySnippet: string;
  locations: string[];
}

class SearchClinicalTrials implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "search_clinical_trials",
      {
        description:
          "Searches ClinicalTrials.gov for matching trials based on the current patient's medical conditions, age, and sex. Reads patient data automatically from FHIR context headers — no manual input required.",
        inputSchema: {
          max_results: z
            .number()
            .optional()
            .default(10)
            .describe("Maximum number of trials to return, default 10"),
        },
      },
      async ({ max_results }) => {
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
          const conditionsData = await conditionsRes.json();
          const conditions: string[] =
            conditionsData.entry?.map(
              (e: any) =>
                e.resource?.code?.coding?.[0]?.display ||
                e.resource?.code?.text,
            ).filter(Boolean) ?? [];

          // Clean conditions dynamically: strip parenthetical text and text after standalone dash
          const cleanedConditions = conditions
            .map((c) => {
              // Remove anything inside parentheses and the parentheses themselves
              let cleaned = c.replace(/\s*\(.*?\)\s*/g, "").trim();
              // Remove anything after a standalone dash
              cleaned = cleaned.replace(/\s+-\s+.*$/, "").trim();
              return cleaned;
            })
            .filter((c) => c.length > 0);

          if (conditions.length === 0) {
            return McpUtilities.createTextResponse(
              "No active conditions found for this patient.",
            );
          }

          // Fetch patient demographics
          const patientRes = await fetch(
            `${fhirServerUrl}/Patient/${patientId}`,
            { headers },
          );
          const patientData = await patientRes.json();

          if (!patientData.birthDate) {
            return McpUtilities.createTextResponse(
              "Patient birth date not found.",
            );
          }

          const age =
            new Date().getFullYear() -
            new Date(patientData.birthDate).getFullYear();
          const sex = patientData.gender?.toLowerCase();

          // Build ClinicalTrials.gov query (use OR for broader search)
          const conditionQuery = cleanedConditions.map(encodeURIComponent).join("+OR+");
          const ctGovUrl = `https://clinicaltrials.gov/api/v2/studies?format=json&query.cond=${conditionQuery}&filter.overallStatus=RECRUITING&pageSize=20`;

          const ctRes = await fetch(ctGovUrl);
          if (!ctRes.ok) {
            return McpUtilities.createTextResponse(
              `Failed to fetch clinical trials: ${ctRes.status}`,
            );
          }
          const ctData = await ctRes.json();

          const matchingTrials: TrialResult[] = [];

          for (const study of ctData.studies || []) {
            const protocol = study.protocolSection;
            if (!protocol) continue;

            const eligibility = protocol.eligibilityModule || {};
            const identification = protocol.identificationModule || {};
            const design = protocol.designModule || {};
            const status = protocol.statusModule || {};
            const contactsLocations = protocol.contactsLocationsModule || {};

            // Sex filter
            const trialSex = eligibility.sex?.toUpperCase();
            if (trialSex !== "ALL" && trialSex !== sex?.toUpperCase()) {
              continue;
            }

            // Age filter with dynamic parsing
            const minAgeYears = this._parseAgeToYears(eligibility.minimumAge);
            const maxAgeYears = this._parseAgeToYears(eligibility.maximumAge);

            // Only exclude if parsed result is non-null AND patient age clearly falls outside
            if (minAgeYears !== null && age < minAgeYears) {
              continue;
            }
            if (maxAgeYears !== null && age > maxAgeYears) {
              continue;
            }

            // Extract trial details
            const nctId = identification.nctId || "Unknown";
            const title = identification.briefTitle || "No title";
            const phases = design.phases?.join(", ") || "N/A";
            const overallStatus = status.overallStatus || "Unknown";
            const eligibilityCriteria = eligibility.eligibilityCriteria || "";
            const eligibilitySnippet =
              eligibilityCriteria.substring(0, 300) +
              (eligibilityCriteria.length > 300 ? "..." : "");

            const locations: string[] = (contactsLocations.locations || [])
              .slice(0, 3)
              .map(
                (loc: any) =>
                  `${loc.facility || "Unknown facility"}, ${loc.city || ""}`,
              );

            matchingTrials.push({
              nctId,
              title,
              phase: phases,
              status: overallStatus,
              eligibilitySnippet,
              locations,
            });

            if (matchingTrials.length >= (max_results ?? 10)) {
              break;
            }
          }

          if (matchingTrials.length === 0) {
            return McpUtilities.createTextResponse(
              `No recruiting trials matched this patient's profile (conditions: ${conditions.join(", ")}, age: ${age}, sex: ${sex}).`,
            );
          }

          // Format output
          const output = matchingTrials
            .map(
              (trial, i) =>
                `---\n**Trial ${i + 1}**\nNCT ID: ${trial.nctId}\nTitle: ${trial.title}\nPhase: ${trial.phase}\nStatus: ${trial.status}\nEligibility Preview: ${trial.eligibilitySnippet}\nLocations: ${trial.locations.join("; ") || "None listed"}`,
            )
            .join("\n");

          return McpUtilities.createTextResponse(
            `Found ${matchingTrials.length} matching trials:\n${output}`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error searching clinical trials: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _parseAgeToYears(ageStr: string | undefined): number | null {
    // Return null if missing/null/undefined/empty
    if (!ageStr || ageStr.trim() === "") {
      return null;
    }

    // Extract numeric part dynamically using parseInt
    const num = parseInt(ageStr, 10);

    // Return null if NaN
    if (isNaN(num)) {
      return null;
    }

    // Extract unit dynamically by checking lowercased string
    const lowerStr = ageStr.toLowerCase();

    if (lowerStr.includes("month")) {
      return num / 12;
    }
    if (lowerStr.includes("week")) {
      return num / 52;
    }
    if (lowerStr.includes("day")) {
      return num / 365;
    }

    // Default: assume years
    return num;
  }
}

export const SearchClinicalTrialsInstance = new SearchClinicalTrials();
