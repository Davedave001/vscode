# Signal-C app connections

Open **Signal-C: Connect App…** from the Command Palette, or choose **Connect an App (OAuth)…** inside **MCP: Add Server…**. These entry points use the same MCP installation, destination, policy, trust and authentication services as manually configured servers. The catalog is defined in `src/vs/workbench/contrib/mcp/common/signalCAppConnections.ts`; it does not own accounts or keep a parallel connection-status database.

Search by app name or description. Selecting an app opens a standard keyboard-accessible review dialog showing its setup requirements and endpoint. **Open Setup Guide** opens the provider's documentation without changing configuration. **Cancel** or Escape exits the step without installing anything. For remote servers, continue with OAuth, name the connection, then select its destination. The suggested name includes a unique suffix so repeated app setup does not default to replacing an earlier account or manual connection; you can edit the name. Authorization happens when the installed server starts, using the owning MCP client's OAuth flow. An installed entry is not proof that authorization completed or that a provider exposed tools to a model.

Registered-client providers such as Asana, Slack, Canva and HubSpot ask for a public OAuth client ID. Register the redirect URLs shown by the authentication flow with that provider. Use the existing MCP credential prompt or **Set Client Secret** action for a client secret; it is not collected by the app picker or embedded in its presets. Provider registration, administrator approval, licensing and regional availability still apply.

## Available apps

The initial catalog covers 22 apps. Intercom has separate US and EU endpoints; QuickBooks has a local-server connection and a separate hosted-pilot setup entry.

| App | Route | Provider setup guide |
| --- | --- | --- |
| QuickBooks Online | Official local stdio server; hosted pilot setup guide | [Intuit local server](https://github.com/intuit/quickbooks-online-mcp-server), [hosted pilot](https://intuitdeveloper.github.io/intuit-3p-ai-pilot/) |
| Notion | Remote HTTP with OAuth | [Notion](https://developers.notion.com/guides/mcp/get-started-with-mcp) |
| Linear | Remote HTTP with OAuth | [Linear](https://linear.app/docs/mcp) |
| GitHub | Remote HTTP with GitHub authorization and client/organization approval as applicable | [GitHub](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/use-the-github-mcp-server) |
| Figma | Remote HTTP with OAuth and provider client/plan controls | [Figma](https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server) |
| Atlassian Rovo | Remote HTTP with OAuth | [Atlassian](https://support.atlassian.com/atlassian-rovo-mcp-server/) |
| Asana | Remote HTTP with a registered OAuth app | [Asana](https://developers.asana.com/docs/integrating-with-asanas-mcp-server) |
| Slack | Remote HTTP with a registered OAuth app | [Slack](https://docs.slack.dev/ai/slack-mcp-server/) |
| Canva | Remote HTTP with a registered OAuth app | [Canva](https://www.canva.dev/docs/apps/mcp/access/) |
| HubSpot | Remote HTTP with an MCP Auth App | [HubSpot](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server) |
| Intercom | Separate US and EU remote HTTP OAuth connections | [Intercom](https://developers.intercom.com/docs/guides/mcp) |
| Stripe | Remote HTTP with OAuth | [Stripe](https://docs.stripe.com/mcp) |
| Sentry | Remote HTTP with OAuth | [Sentry](https://mcp.sentry.dev/) |
| Cloudflare | Remote HTTP with OAuth | [Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) |
| Vercel | Remote HTTP with OAuth | [Vercel](https://vercel.com/docs/agent-resources/vercel-mcp) |
| Neon | Remote HTTP with OAuth | [Neon](https://neon.com/docs/ai/neon-mcp-server) |
| monday.com | Remote HTTP with OAuth | [monday.com](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration) |
| Todoist | Remote HTTP with OAuth | [Todoist](https://developer.todoist.com/api/v1/) |
| ClickUp | Remote HTTP with OAuth | [ClickUp](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server) |
| Airtable | Remote HTTP with OAuth | [Airtable](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server) |
| Miro | Remote HTTP with OAuth | [Miro](https://developers.miro.com/docs/miro-mcp-server-faq-and-troubleshooting) |
| Webflow | Remote HTTP with OAuth and site/Designer prerequisites | [Webflow](https://developers.webflow.com/mcp/reference/getting-started) |

## QuickBooks local connection

1. Follow Intuit's official repository to build its local MCP server and complete its OAuth setup for your company. Production and sandbox callback requirements differ; use Intuit's instructions for the selected environment.
2. Choose **QuickBooks Online (Local Server)**, review the requirements, and choose **Connect Local Server**.
3. Select the built JavaScript entrypoint, then the private OAuth token-store file used by that server. The picker accepts local files only and does not read the token-store contents.
4. Name the connection. Signal-C installs it in local user MCP configuration with `node`, the selected entrypoint, and `QUICKBOOKS_TOKEN_STORE_PATH` referencing the selected private file. Intuit's server reads and rotates its own tokens. Node.js and the server's dependencies must already be installed.

This local preset does not send machine-specific paths to an agent host or write them to Copilot Global. An explicit workspace or agent-host target is refused before collecting paths; invoke the standalone Connect App command to use local user configuration. Starting and exposing this server still uses the existing MCP trust and tool-approval controls.

Intuit's hosted MCP is an invitation-only pilot requiring app/IP/scope onboarding. Its public protected-resource metadata currently identifies `https://mcp.quickbooks.intuit.com?resource_query=mcp`, which does not match the resource expected by RFC 9728 discovery for the documented `/mcp` endpoint. Signal-C retains resource and issuer validation and keeps this entry setup-only. Recheck the provider's metadata before enabling hosted installation; a QuickBooks subscription does not establish pilot access.

## Verification

The focused MCP configuration entry-point tests cover remote installation and start routing, registered client IDs, setup-guide actions, cancellation at each step, selected agent-host ownership and policy rejection, and QuickBooks local path-only configuration, local ownership and file-picker cancellation. No test reads a real token store or authorizes a provider account.

Run `node scripts/test-agent-workspace-native.mts --empty-workspace --keyboard --app-connections` on the prepared Windows development runtime after compiling the client. It uses a fresh hidden portable fixture, opens the app picker from the real Command Palette, checks QuickBooks local availability and the hosted-pilot review, cancels setup, and checks that fixture MCP configuration remains unchanged. It then verifies mode-switch keyboard dispatch, window reuse, unsaved buffers and the Agents draft. Artifacts remain under `.build/agent-workspace-native-smoke/<run>/`.

Public discovery checks use the actual `AgentHostMcpOAuthMetadataService` with credential-free HTTPS GET requests. Discovery of a resource/issuer chain does not establish OAuth grant completion, account entitlement, refresh behavior, or successful tool calls. These require separate provider-account validation. The local QuickBooks wizard configures an existing official installation; it does not install that server or perform its initial OAuth handshake.
