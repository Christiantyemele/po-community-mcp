import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { McpUtilities } from "../mcp-utilities";

class GetTrialDetails implements IMcpTool {
  registerTool(server: McpServer, _req: Request) {
    server.registerTool(
      "get_trial_details",
      {
        description:
          "Fetches complete structured details for a specific clinical trial by NCT ID including protocol, eligibility criteria, contacts, and site locations.",
        inputSchema: {
          nct_id: z
            .string()
            .describe(
              "ClinicalTrials.gov NCT identifier e.g. NCT04179552",
            ),
        },
      },
      async ({ nct_id }) => {
        try {
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

          if (!protocol) {
            return McpUtilities.createTextResponse(
              "Trial protocol data not available.",
              { isError: true },
            );
          }

          const identification = protocol.identificationModule || {};
          const status = protocol.statusModule || {};
          const sponsorCollaborators = protocol.sponsorCollaboratorsModule || {};
          const design = protocol.designModule || {};
          const eligibility = protocol.eligibilityModule || {};
          const outcomes = protocol.outcomesModule || {};
          const contactsLocations = protocol.contactsLocationsModule || {};

          // Extract outcomes
          const primaryOutcomes = (outcomes.primaryOutcomes || [])
            .slice(0, 3)
            .map((o: any) => o.measure || "N/A");
          const secondaryOutcomes = (outcomes.secondaryOutcomes || [])
            .slice(0, 3)
            .map((o: any) => o.measure || "N/A");

          // Extract locations
          const locations = (contactsLocations.locations || [])
            .slice(0, 5)
            .map((loc: any) => {
              const facility = loc.facility || "Unknown facility";
              const city = loc.city || "";
              const country = loc.country || "";
              const contact =
                loc.contacts?.[0]?.name || loc.contacts?.[0]?.phone || "";
              return `${facility}, ${city}, ${country}${contact ? ` (Contact: ${contact})` : ""}`;
            });

          // Extract central contacts
          const centralContacts = (contactsLocations.centralContacts || [])
            .map(
              (c: any) =>
                `${c.name || "Unknown"} (${c.role || "N/A"}): ${c.phone || c.email || "No contact info"}`,
            );

          const report = `
=== IDENTIFICATION ===
NCT ID: ${identification.nctId || nct_id}
Brief Title: ${identification.briefTitle || "N/A"}
Official Title: ${identification.officialTitle || "N/A"}

=== STATUS ===
Overall Status: ${status.overallStatus || "N/A"}
Start Date: ${status.startDateStruct?.date || "N/A"}
Primary Completion: ${status.primaryCompletionDateStruct?.date || "N/A"}

=== SPONSOR ===
Lead Sponsor: ${sponsorCollaborators.leadSponsor?.name || "N/A"}

=== DESIGN ===
Study Type: ${design.studyType || "N/A"}
Phases: ${design.phases?.join(", ") || "N/A"}
Target Enrollment: ${design.enrollmentInfo?.count || "N/A"}

=== ELIGIBILITY ===
Sex: ${eligibility.sex || "ALL"}
Age Range: ${eligibility.minimumAge || "No minimum"} - ${eligibility.maximumAge || "No maximum"}
Eligibility Criteria:
${eligibility.eligibilityCriteria || "No criteria specified"}

=== PRIMARY OUTCOMES ===
${primaryOutcomes.length > 0 ? primaryOutcomes.map((o: string) => `• ${o}`).join("\n") : "None specified"}

=== SECONDARY OUTCOMES ===
${secondaryOutcomes.length > 0 ? secondaryOutcomes.map((o: string) => `• ${o}`).join("\n") : "None specified"}

=== LOCATIONS ===
${locations.length > 0 ? locations.map((l: string) => `• ${l}`).join("\n") : "No locations listed"}

=== CENTRAL CONTACTS ===
${centralContacts.length > 0 ? centralContacts.map((c: string) => `• ${c}`).join("\n") : "No central contacts listed"}
`.trim();

          return McpUtilities.createTextResponse(report);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error fetching trial details: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const GetTrialDetailsInstance = new GetTrialDetails();
