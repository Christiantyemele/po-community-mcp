import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { McpUtilities } from "../mcp-utilities";

class ExplainEligibilityCriteria implements IMcpTool {
  registerTool(server: McpServer, _req: Request) {
    server.registerTool(
      "explain_eligibility_criteria",
      {
        description:
          "Translates complex clinical trial eligibility criteria into plain language. Separates inclusion and exclusion criteria into clearly labeled sections a patient or non-specialist clinician can understand.",
        inputSchema: {
          nct_id: z
            .string()
            .optional()
            .describe("NCT ID to auto-fetch criteria — provide this OR raw_criteria"),
          raw_criteria: z
            .string()
            .optional()
            .describe("Raw eligibility criteria text — provide this OR nct_id"),
        },
      },
      async ({ nct_id, raw_criteria }) => {
        let criteriaText = "";

        try {
          if (nct_id) {
            const res = await fetch(
              `https://clinicaltrials.gov/api/v2/studies/${nct_id}?format=json`,
            );

            if (!res.ok) {
              if (res.status === 404) {
                return McpUtilities.createTextResponse(
                  `Trial ${nct_id} not found.`,
                );
              }
              return McpUtilities.createTextResponse(
                `Failed to fetch trial: ${res.status}`,
                { isError: true },
              );
            }

            const data = await res.json();
            const protocol = data.protocolSection;

            if (!protocol?.eligibilityModule?.eligibilityCriteria) {
              return McpUtilities.createTextResponse(
                "No eligibility criteria found for this trial.",
              );
            }

            criteriaText = protocol.eligibilityModule.eligibilityCriteria;
          } else if (raw_criteria) {
            criteriaText = raw_criteria;
          } else {
            return McpUtilities.createTextResponse(
              "Please provide either nct_id or raw_criteria parameter.",
              { isError: true },
            );
          }

          // Split into inclusion and exclusion
          const inclusionMatch = criteriaText.match(
            /Inclusion Criteria[:\s]*([\s\S]*?)(?=Exclusion Criteria|$)/i,
          );
          const exclusionMatch = criteriaText.match(
            /Exclusion Criteria[:\s]*([\s\S]*?)$/i,
          );

          let inclusionText = inclusionMatch?.[1] || "";
          let exclusionText = exclusionMatch?.[1] || "";

          // If no clear split, treat whole text as inclusion
          if (!inclusionMatch && !exclusionMatch) {
            inclusionText = criteriaText;
          }

          // Apply plain language replacements
          const replacements: [RegExp, string][] = [
            [/ECOG PS/gi, "performance status (ECOG)"],
            [/NSCLC/gi, "non-small cell lung cancer"],
            [/eGFR/gi, "kidney filtration rate (eGFR)"],
            [/\bALT\b/g, "liver enzyme levels (ALT)"],
            [/\bAST\b/g, "liver enzyme levels (AST)"],
            [/\bANC\b/g, "white blood cell count (ANC)"],
            [/histologically confirmed/gi, "confirmed by biopsy"],
            [/adequate hepatic function/gi, "normal liver function"],
            [/prior systemic therapy/gi, "previous cancer treatment"],
            [/Eastern Cooperative Oncology Group/gi, "performance status scale (ECOG)"],
          ];

          const applyReplacements = (text: string): string => {
            let result = text;
            for (const [pattern, replacement] of replacements) {
              result = result.replace(pattern, replacement);
            }
            return result;
          };

          inclusionText = applyReplacements(inclusionText);
          exclusionText = applyReplacements(exclusionText);

          // Parse into list items
          const parseToList = (text: string): string[] => {
            // Split by common delimiters
            const lines = text
              .split(/\n|•|-\s|\d+\.\s/)
              .map((line) => line.trim())
              .filter((line) => line.length > 10 && !line.match(/^(Inclusion|Exclusion)\s*Criteria/i));

            return lines;
          };

          const inclusionList = parseToList(inclusionText);
          const exclusionList = parseToList(exclusionText);

          // Generate summary
          const summary = this._generateSummary(inclusionList, exclusionList);

          const report = `
=== SUMMARY ===
${summary}

=== INCLUSION CRITERIA ===
${inclusionList.length > 0 ? inclusionList.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No specific inclusion criteria listed."}

=== EXCLUSION CRITERIA ===
${exclusionList.length > 0 ? exclusionList.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No specific exclusion criteria listed."}
`.trim();

          return McpUtilities.createTextResponse(report);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error explaining eligibility criteria: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _generateSummary(
    inclusionList: string[],
    exclusionList: string[],
  ): string {
    const inclusionCount = inclusionList.length;
    const exclusionCount = exclusionList.length;

    if (inclusionCount === 0 && exclusionCount === 0) {
      return "This trial does not have detailed eligibility criteria available.";
    }

    const parts: string[] = [];

    if (inclusionCount > 0) {
      // Try to identify key characteristics
      const keyTerms = inclusionList.slice(0, 3).join("; ");
      parts.push(
        `This trial is seeking participants who meet ${inclusionCount} inclusion criteria, including: ${keyTerms.substring(0, 150)}...`,
      );
    }

    if (exclusionCount > 0) {
      parts.push(
        `Participants will be excluded if they meet any of ${exclusionCount} exclusion criteria.`,
      );
    }

    return parts.join(" ");
  }
}

export const ExplainEligibilityCriteriaInstance = new ExplainEligibilityCriteria();
