/**
 * Service activation shared by every experimental presentation: the terminal
 * client and the IRC bot. No Node imports, no transport knowledge; it takes an already connected `Client` and its service sources.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Client } from "@earendil-works/pi-client";
import { AgentController } from "./services/agent-controller.ts";
import type { ServerServiceSource, SessionServiceSource } from "./services/connection.ts";
import { Models } from "./services/models.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { SessionDirectory, SessionManagement } from "./services/sessions.ts";
import { Transcript } from "./services/transcript.ts";

export interface ConnectedClientServer {
	readonly client: Client;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
}

export interface ActivatedClientServices {
	readonly directory: SessionDirectory;
	readonly management: SessionManagement;
	readonly plugins: PresentationPlugins;
	readonly models: Models;
	readonly agent: AgentController;
	readonly transcript: Transcript;
}

/** Acquire and connect the built-in service facades used by the non-interactive client. */
export async function activateBuiltinClientServices<T extends ConnectedClientServer>(
	server: T,
): Promise<T & ActivatedClientServices> {
	const serverServices = server.server.open({
		services: [SessionDirectory, SessionManagement, PresentationPlugins],
		assertAccess() {},
		onError() {},
	});
	const sessionServices = server.session.open({
		services: [Models, AgentController, Transcript],
		assertAccess() {},
		onError() {},
	});
	const directory = serverServices.use(SessionDirectory);
	const remoteManagement = serverServices.use(SessionManagement);
	const management: SessionManagement = {
		create: (options, context) => remoteManagement.create(options, context),
		fork: (sourceSessionId, options, context) => remoteManagement.fork(sourceSessionId, options, context),
		async remove(sessionId, context) {
			const removesCurrentAttachment = server.client.attachment?.sessionId === sessionId;
			await remoteManagement.remove(sessionId, context);
			if (removesCurrentAttachment) await server.session.whenDetached(context);
		},
		async attach(sessionId, context) {
			await remoteManagement.attach(sessionId, context);
			await server.session.whenAttached(sessionId, context);
		},
		async detach(context) {
			await remoteManagement.detach(context);
			await server.session.whenDetached(context);
		},
	};
	const plugins = serverServices.use(PresentationPlugins);
	const models = sessionServices.use(Models);
	const agent = sessionServices.use(AgentController);
	const transcript = sessionServices.use(Transcript);
	await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
	return { ...server, directory, management, plugins, models, agent, transcript };
}
