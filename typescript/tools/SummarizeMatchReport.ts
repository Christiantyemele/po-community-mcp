import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";

class SummarizeMatchReport implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "summarize_match_report",
      {
        description:
          "Generates a concise clinician-ready summary report of clinical trial matches for the current patient. Readable in under 60 seconds during a clinical consultation.",
        inputSchema: {
          patient_label: z
            .string()
            .describe(
              "De-identified label e.g. 'Patient A' or 'PT-2024-001' — never use real names",
            ),
          matched_trials: z
            .array(
              z.object({
                nct_id: z.string(),
                title: z.string(),
                phase: z.string(),
                eligibility_assessment: z.enum([
                  "LIKELY ELIGIBLE",
                  "UNCERTAIN",
                  "LIKELY INELIGIBLE",
                ]),
                key_flags: z.array(z.string()),
              }),
            )
            .describe(
              "Trials previously evaluated using evaluate_trial_eligibility",
            ),
          clinical_context: z
            .string()
            .optional()
            .describe(
              "Additional context e.g. treatment history, performance status",
            ),
        },
      },
      async ({ patient_label, matched_trials, clinical_context }) => {
        const fhirContext = FhirUtilities.getFhirContext(req);
        const patientId = FhirUtilities.getPatientIdIfContextExists(req);

        // Initialize patient data
        let age = "Unknown";
        let sex = "Unknown";
        let conditions: string[] = [];

        // Fetch FHIR data if context available
        if (fhirContext?.url && patientId) {
          const headers: Record<string, string> = {
            Accept: "application/fhir+json",
          };
          if (fhirContext.token) {
            headers["Authorization"] = `Bearer ${fhirContext.token}`;
          }

          try {
            // Fetch demographics
            const patientRes = await fetch(
              `${fhirContext.url}/Patient/${patientId}`,
              { headers },
            );
            if (patientRes.ok) {
              const patientData = await patientRes.json();
              if (patientData.birthDate) {
                age = (
                  new Date().getFullYear() -
                  new Date(patientData.birthDate).getFullYear()
                ).toString();
              }
              if (patientData.gender) {
                sex = patientData.gender.toUpperCase();
              }
            }

            // Fetch conditions
            const conditionsRes = await fetch(
              `${fhirContext.url}/Condition?patient=${patientId}&clinical-status=active`,
              { headers },
            );
            if (conditionsRes.ok) {
              const conditionsData = await conditionsRes.json();
              conditions =
                conditionsData.entry?.map(
                  (e: any) =>
                    e.resource?.code?.coding?.[0]?.display ||
                    e.resource?.code?.text,
                ).filter(Boolean) ?? [];
            }
          } catch {
            // Continue with default values if FHIR fetch fails
          }
        }

        // Categorize trials
        const likelyEligible = matched_trials.filter(
          (t) => t.eligibility_assessment === "LIKELY ELIGIBLE",
        );
        const uncertain = matched_trials.filter(
          (t) => t.eligibility_assessment === "UNCERTAIN",
        );
        const likelyIneligible = matched_trials.filter(
          (t) => t.eligibility_assessment === "LIKELY INELIGIBLE",
        );

        // Build report
        const timestamp = new Date().toISOString();

        let report = `
=== CLINICAL TRIAL MATCH REPORT ===
Generated: ${timestamp}
Patient: ${patient_label}

--- PATIENT SUMMARY ---
Age: ${age}
Sex: ${sex}
Active Conditions: ${conditions.length > 0 ? conditions.join(", ") : "None documented"}
${clinical_context ? `Clinical Context: ${clinical_context}` : ""}

--- MATCH OVERVIEW ---
Total Trials Evaluated: ${matched_trials.length}
Likely Eligible: ${likelyEligible.length}
Uncertain: ${uncertain.length}
Likely Ineligible: ${likelyIneligible.length}
`.trim();

        // Top candidates section
        if (likelyEligible.length > 0) {
          report += "\n\n--- TOP CANDIDATES (LIKELY ELIGIBLE) ---\n";
          report += likelyEligible
            .map(
              (t, i) =>
                `${i + 1}. [${t.nct_id}] ${t.title}\n   Phase: ${t.phase}\n   Flags: ${t.key_flags.length > 0 ? t.key_flags.join(", ") : "None"}`,
            )
            .join("\n");
        } else if (uncertain.length > 0) {
          report += "\n\n--- NO LIKELY ELIGIBLE TRIALS ---\n";
          report += "The following trials require additional verification:\n";
        }

        // Uncertain trials section
        if (uncertain.length > 0) {
          report += "\n\n--- TRIALS NEEDING MORE INFO ---\n";
          report += uncertain
            .map(
              (t, i) =>
                `${i + 1}. [${t.nct_id}] ${t.title}\n   Phase: ${t.phase}\n   Flags: ${t.key_flags.length > 0 ? t.key_flags.join(", ") : "None"}\n   Action Needed: Verify eligibility criteria against patient data`,
            )
            .join("\n");
        }

        // Recommended next steps
        report += "\n\n--- RECOMMENDED NEXT STEPS ---\n";
        const nextSteps: string[] = [];

        if (likelyEligible.length > 0 && likelyEligible[0]?.nct_id) {
          nextSteps.push(
            `Contact trial coordinator for ${likelyEligible[0].nct_id} to confirm enrollment eligibility`,
          );
          if (conditions.length === 0) {
            nextSteps.push(
              "Verify patient conditions in EHR before proceeding",
            );
          }
        } else if (uncertain.length > 0) {
          nextSteps.push(
            "Review uncertain trials with treating physician for clinical judgment",
          );
          nextSteps.push(
            `Gather additional lab/imaging data to resolve eligibility questions`,
          );
        } else {
          nextSteps.push(
            "Consider broadening search criteria or exploring alternative treatment options",
          );
        }

        if (likelyIneligible.length > 0) {
          nextSteps.push(
            `${likelyIneligible.length} trial(s) excluded due to eligibility constraints — review if patient status changes`,
          );
        }

        report += nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");

        // Metadata
        report += `\n\n--- REPORT METADATA ---\n`;
        report += `Timestamp: ${timestamp}\n`;
        report += `Disclaimer: All patient data is de-identified. Clinical decisions should be made in consultation with the treating physician.\n`;
        report += `Data Source: ClinicalTrials.gov API v2`;

        return McpUtilities.createTextResponse(report);
      },
    );
  }
}

export const SummarizeMatchReportInstance = new SummarizeMatchReport();
