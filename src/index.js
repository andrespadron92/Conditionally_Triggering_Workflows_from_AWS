// AWS Lambda handler — triggered by an SQS queue that receives PagerDuty V3 webhooks
// (incident.triggered) from a service-level email integration.
//
// Purpose: PagerDuty service-level email integrations only support email
// filters/rules — they cannot inspect the email body to decide whether an
// Incident Workflow should run. This function closes that gap: it reads the
// original email body back from PagerDuty's REST API and conditionally
// triggers an Incident Workflow, or posts a note documenting why it didn't.
//
// Runtime: Node.js 24.x · Region: us-east-1
// Required environment variable: PAGERDUTY_API_TOKEN (a PagerDuty REST API token)

export const handler = async (event) => {
    // 1. Initial Integration Setup Variables
    const authToken = `Token token=${process.env.PAGERDUTY_API_TOKEN}`;
    const workflowId = 'PYW8VXV';

    console.log(`Lambda function triggered. Processing SQS batch...`);

    // 2. AWS SQS passes webhooks inside an array of Records
    for (const record of event.Records) {
        try {
            // Dynamically grab the incoming webhook payload string and parse it to JSON
            const webhookBody = JSON.parse(record.body);

            // Extract the incident dynamic ID from the incoming PagerDuty payload structure
            const incidentId = webhookBody?.event?.data?.id;

            if (!incidentId) {
                console.log(":warning: Skipping record: No valid incident ID found in the webhook envelope data.");
                continue;
            }

            console.log(`Successfully captured dynamic Incident ID from SQS: ${incidentId}`);

            // 3. Construct the GET request to fetch expanded incident logs
            const apiUrl = `https://api.pagerduty.com/incidents/${incidentId}?include[]=first_trigger_log_entries`;
            console.log(`Sending GET request to PagerDuty to check channel body...`);

            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': authToken,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`PagerDuty Incident Fetch API returned status ${response.status}`);
            }

            const incidentData = await response.json();

            // Extracting the email channel body text
            const channelBody = incidentData?.incident?.first_trigger_log_entry?.channel?.body;

            if (!channelBody) {
                console.log(`:warning: Could not locate channel.body for Incident ${incidentId}. Skipping pattern matching.`);
                continue;
            }

            console.log(`Found Channel Body text for Incident ${incidentId}. Scanning for "Incident Workflow"...`);

            // Case-insensitive regex evaluation looking for "Incident Workflow"
            const  workflowRegex = /incident\s*workflow/i;
            const containsWorkflow = workflowRegex.test(channelBody);

            // --- CONDITION 1: "Incident Workflow" IS FOUND ---
            if (containsWorkflow) {
                console.log(":white_check_mark: Match found! Posting timeline note and triggering workflow...");

                // Post a positive verification note to the timeline first
                const createNoteUrl = `https://api.pagerduty.com/incidents/${incidentId}/notes`;
                await fetch(createNoteUrl, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': authToken,
                        'Content-Type': 'application/json',
                        'From': process.env.PAGERDUTY_FROM_EMAIL
                    },
                    body: JSON.stringify({
                        "note": {
                            "content": "Lambda Function Automation: 'Incident Workflow' pattern match succeeded. Triggering workflow."
                        }
                    })
                 });

                // Construct the Incident Workflow execution URL
                const workflowUrl = `https://api.pagerduty.com/incident_workflows/${workflowId}/instances`;
                const workflowBody = {
                        "incident_workflow_instance": {
                                "id": workflowId,
                                "type": "Workflow_reference",
                                "incident":{
                                    "id": incidentId, // Injected dynamically
                                    "type": "incident_reference"
                            }
                        }
                };

                const wfResponse = await fetch(workflowUrl, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': authToken,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(workflowBody)
                });

                if (wfResponse.ok) {
                    console.log(":tada: Successfully triggered the Incident Workflow!");
                } else {
                    console.error(`:x: Workflow Trigger Failed Status ${wfResponse.status}: ${await wfResponse.text()}`);

                    // Fallback path if the URL routing layer drops a 404
                    // NOTE: known bug carried over from the original deployment —
                    // `triggerId` below is never declared. If this branch executes,
                    // it throws a ReferenceError that is swallowed by the outer catch.
                    // Left as-is here for an honest record of the code as deployed;
                    // fix before reusing this fallback path.
                    if (wfResponse.status === 404) {
                        console.log(":arrows_counterclockwise: Attempting alternative endpoint path layout (/triggers/start)...");
                        const altWorkflowUrl = `https://api.pagerduty.com/incident_workflows/triggers/start`;

                        const altResponse = await fetch(altWorkflowUrl, {
                            method: 'POST',
                            headers: {
                                'Accept': 'application/json',
                                'Authorization': authToken,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                "trigger_id": triggerId,
                                ...workflowBody
                            })
                        });

                        if (altResponse.ok) {
                            console.log(":tada: Successfully triggered the Incident Workflow via alternative endpoint mapping!");
                        } else {
                            console.error(`:x: Alternative Endpoint Failed Status ${altResponse.status}: ${await altResponse.text()}`);
                        }
                    }
                }

            // --- CONDITION 2: "Incident Workflow" IS NOT FOUND (Create a Note Endpoint) ---
            } else {
                console.log(":x: Keywords not found. Executing Create a Note on an Incident API...");

                const createNoteUrl = `https://api.pagerduty.com/incidents/${incidentId}/notes`;
                const noteBody = {
                    "note": {
                        "content": "Lambda Function Automation: 'Incident Workflow' match failed. Skipping trigger."
                    }
                };

                const noteResponse = await fetch(createNoteUrl, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Authorization': authToken,
                        'Content-Type': 'application/json',
                        'From': process.env.PAGERDUTY_FROM_EMAIL
                    },
                    body: JSON.stringify(noteBody)
                });

            if (noteResponse.ok) {
                const noteData = await noteResponse.json();
                console.log(`:tada: Note successfully created! Note ID: ${noteData?.note?.id}`);
            } else {
                console.error(`:x: Create Note Failed Status ${noteResponse.status}: ${await noteResponse.text()}`);
            }
        }

        } catch (error) {
            // Catches isolated loop execution anomalies so a single corrupt message doesn't crash the entire SQS queue worker thread
            console.error(`:x: Error processing batch record: ${error.message}`);
        }
    }

    return {
        statusCode: 200,
        body: "Processed SQS data streams cleanly."
    };
};
