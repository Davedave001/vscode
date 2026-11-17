/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

export interface ISignalCAppConnection {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly url?: string;
	readonly documentation: string;
	readonly setup?: string;
	readonly clientIdRequired?: boolean;
	readonly headers?: Readonly<Record<string, string>>;
	readonly blocked?: string;
	readonly local?: { readonly command: string; readonly tokenStoreVariable: string };
}

/** Vendor-published MCP connection presets. OAuth and connection state remain owned by the MCP services. */
export const signalCAppConnections: readonly ISignalCAppConnection[] = [
	{
		id: 'quickbooks-local', name: 'QuickBooks Online (Local Server)',
		description: localize('apps.quickbooks.local', "Official Intuit MCP server with your company's OAuth connection"),
		documentation: 'https://github.com/intuit/quickbooks-online-mcp-server',
		setup: localize('apps.quickbooks.local.setup', "Build Intuit's official QuickBooks MCP server and complete its OAuth setup first. Choose its built JavaScript entrypoint and your private token-store file next. Signal-C saves only those paths in local user configuration; the official server reads and refreshes its own OAuth tokens. Node.js must be available on this machine."),
		local: { command: 'node', tokenStoreVariable: 'QUICKBOOKS_TOKEN_STORE_PATH' },
	},
	{
		id: 'quickbooks', name: 'QuickBooks Online (Hosted Pilot)',
		description: localize('apps.quickbooks', "Accounting, customers, invoices and reports"),
		url: 'https://mcp.quickbooks.intuit.com/mcp',
		documentation: 'https://intuitdeveloper.github.io/intuit-3p-ai-pilot/',
		setup: localize('apps.quickbooks.setup', "Intuit's hosted MCP is an invitation-only pilot. Your Intuit app, IP range and restricted MCP scopes must be approved. Use that app's public OAuth client ID; a QuickBooks subscription alone does not grant pilot access."),
		clientIdRequired: true, headers: { 'User-Agent': 'partner_app_Signal-C' },
		blocked: localize('apps.quickbooks.hosted.blocked', "Sign-in to the hosted pilot is currently unavailable in Signal-C. Choose QuickBooks Online (Local Server), or contact your Intuit Solution Engineer if you are a pilot partner."),
	},
	{ id: 'notion', name: 'Notion', description: localize('apps.notion', "Pages, databases, documents and project knowledge"), url: 'https://mcp.notion.com/mcp', documentation: 'https://developers.notion.com/guides/mcp/get-started-with-mcp' },
	{ id: 'linear', name: 'Linear', description: localize('apps.linear', "Issues, projects, cycles and planning"), url: 'https://mcp.linear.app/mcp', documentation: 'https://linear.app/docs/mcp' },
	{ id: 'github', name: 'GitHub', description: localize('apps.github', "Repositories, issues, pull requests and workflows"), url: 'https://api.githubcopilot.com/mcp/', documentation: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/use-the-github-mcp-server', setup: localize('apps.github.setup', "GitHub organization policies and OAuth client approval may apply. The server will request the account permissions it needs.") },
	{ id: 'figma', name: 'Figma', description: localize('apps.figma', "Designs, components, variables and canvas context"), url: 'https://mcp.figma.com/mcp', documentation: 'https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server', setup: localize('apps.figma.setup', "Figma controls supported MCP clients and plan limits. Your client may need approval from Figma.") },
	{ id: 'atlassian', name: 'Atlassian Rovo', description: localize('apps.atlassian', "Jira, Confluence, Bitbucket and team knowledge"), url: 'https://mcp.atlassian.com/v2/mcp', documentation: 'https://support.atlassian.com/atlassian-rovo-mcp-server/', setup: localize('apps.atlassian.setup', "Your Atlassian administrator may need to allow this client and the products you want to access.") },
	{ id: 'asana', name: 'Asana', description: localize('apps.asana', "Tasks, projects, portfolios and team work"), url: 'https://mcp.asana.com/v2/mcp', documentation: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server', clientIdRequired: true, setup: localize('apps.asana.setup', "Create an Asana MCP OAuth app and register the redirect URLs shown during authentication. Keep its client secret in the MCP credential store when requested.") },
	{ id: 'slack', name: 'Slack', description: localize('apps.slack', "Workspace messages, channels and collaboration"), url: 'https://mcp.slack.com/mcp', documentation: 'https://docs.slack.dev/ai/slack-mcp-server/', clientIdRequired: true, setup: localize('apps.slack.setup', "Use a Slack OAuth app enabled for the MCP server. Workspace administrator approval may be required.") },
	{ id: 'canva', name: 'Canva', description: localize('apps.canva', "Designs, brand assets and presentations"), url: 'https://api.canva.com/connect/v1/mcp', documentation: 'https://www.canva.dev/docs/apps/mcp/access/', clientIdRequired: true, setup: localize('apps.canva.setup', "Register your AI application in the Canva Developer Portal and use its OAuth client ID. Each user authorizes their own Canva access.") },
	{ id: 'hubspot', name: 'HubSpot', description: localize('apps.hubspot', "CRM contacts, companies, deals and activities"), url: 'https://mcp.hubspot.com', documentation: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server', clientIdRequired: true, setup: localize('apps.hubspot.setup', "Create an MCP Auth App in HubSpot. Use its client ID and provide the client secret through the MCP credential prompt or Set Client Secret action.") },
	{ id: 'intercom-us', name: 'Intercom (US)', description: localize('apps.intercom.us', "US-hosted conversations, contacts and support"), url: 'https://mcp.intercom.com/mcp', documentation: 'https://developers.intercom.com/docs/guides/mcp' },
	{ id: 'intercom-eu', name: 'Intercom (EU)', description: localize('apps.intercom.eu', "EU-hosted conversations, contacts and support"), url: 'https://mcp.eu.intercom.com/mcp', documentation: 'https://developers.intercom.com/docs/guides/mcp' },
	{ id: 'stripe', name: 'Stripe', description: localize('apps.stripe', "Payments, customers, invoices and subscriptions"), url: 'https://mcp.stripe.com', documentation: 'https://docs.stripe.com/mcp' },
	{ id: 'sentry', name: 'Sentry', description: localize('apps.sentry', "Errors, performance, issues and project diagnostics"), url: 'https://mcp.sentry.dev/mcp', documentation: 'https://mcp.sentry.dev/' },
	{ id: 'cloudflare', name: 'Cloudflare', description: localize('apps.cloudflare', "DNS, Workers, R2, security and cloud services"), url: 'https://mcp.cloudflare.com/mcp', documentation: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/' },
	{ id: 'vercel', name: 'Vercel', description: localize('apps.vercel', "Projects, deployments and hosting"), url: 'https://mcp.vercel.com', documentation: 'https://vercel.com/docs/agent-resources/vercel-mcp' },
	{ id: 'neon', name: 'Neon', description: localize('apps.neon', "Postgres databases, branches and project management"), url: 'https://mcp.neon.tech/mcp', documentation: 'https://neon.com/docs/ai/neon-mcp-server' },
	{ id: 'monday', name: 'monday.com', description: localize('apps.monday', "Boards, work items, projects and team workflows"), url: 'https://mcp.monday.com/mcp', documentation: 'https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration' },
	{ id: 'todoist', name: 'Todoist', description: localize('apps.todoist', "Tasks, projects and personal planning"), url: 'https://ai.todoist.net/mcp', documentation: 'https://developer.todoist.com/api/v1/' },
	{ id: 'clickup', name: 'ClickUp', description: localize('apps.clickup', "Tasks, spaces, documents and project work"), url: 'https://mcp.clickup.com/mcp', documentation: 'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server' },
	{ id: 'airtable', name: 'Airtable', description: localize('apps.airtable', "Bases, tables, records and structured work"), url: 'https://mcp.airtable.com/mcp', documentation: 'https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server' },
	{ id: 'miro', name: 'Miro', description: localize('apps.miro', "Boards, diagrams and visual collaboration"), url: 'https://mcp.miro.com/', documentation: 'https://developers.miro.com/docs/miro-mcp-server-faq-and-troubleshooting' },
	{ id: 'webflow', name: 'Webflow', description: localize('apps.webflow', "Sites, CMS content and design workflows"), url: 'https://mcp.webflow.com/mcp', documentation: 'https://developers.webflow.com/mcp/reference/getting-started', setup: localize('apps.webflow.setup', "Site owner or administrator access is required for authorization. Designer tools also require the Webflow MCP Bridge app to remain open.") },
];
