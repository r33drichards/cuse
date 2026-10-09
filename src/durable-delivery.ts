import type { DurableIrcStore, InboxMessage } from "./durable-store.js";
import { toIrcLines } from "./format.js";

export interface DurablePromptSession {
	/** Must reconcile this stable ID with persisted execution, never blindly start it again. */
	promptDurable(
		id: string,
		body: string,
	): Promise<{ text: string; steered: boolean }>;
	abort(): Promise<void>;
}
export interface DurableDeliveryHandlers {
	open(channel: string): Promise<DurablePromptSession>;
	deliver(channel: string, text: string): Promise<void>;
	canDeliver?(channel: string): boolean;
	report(channel: string, error: unknown): void;
}

/** Opt-in serial inbox: accepted prompts queue durably rather than steering an active turn. */
export class DurableDelivery {
	private readonly store: DurableIrcStore;
	private readonly handlers: DurableDeliveryHandlers;
	private readonly workers = new Map<string, Promise<void>>();
	private readonly sessions = new Map<string, DurablePromptSession>();
	private readonly blocked = new Set<string>();
	private readonly activeMessages = new Map<string, InboxMessage>();
	private outputWorker?: Promise<void>;
	private closing = false;
	private closePromise?: Promise<void>;
	private drained = false;

	constructor(store: DurableIrcStore, handlers: DurableDeliveryHandlers) {
		this.store = store;
		this.handlers = handlers;
	}

	getMessage(id: string): InboxMessage | undefined {
		return this.store.listInbox().find((message) => message.id === id);
	}

	/** Persistence completes synchronously before the caller may acknowledge acceptance. */
	enqueue(message: InboxMessage): boolean {
		if (this.closing) throw new Error("Durable IRC delivery is closing");
		const added = this.store.enqueue(message);
		this.kick(message.channel);
		return added;
	}

	currentMessage(channel: string): Readonly<InboxMessage> | undefined {
		const message = this.activeMessages.get(channel);
		return message ? structuredClone(message) : undefined;
	}

	/** Explicit recovery retries the original operation IDs through the idempotent adapter. */
	async startChannel(channel: string): Promise<void> {
		try {
			if (this.closing) return;
			const active = this.workers.get(channel);
			if (active) {
				await active;
				return;
			}
			for (const message of this.store.listInbox("recovery-required")) {
				if (message.channel === channel) this.store.retry(message.id);
			}
			this.blocked.delete(channel);
			this.kick(channel);
			await this.workers.get(channel);
		} catch (error) {
			this.blocked.add(channel);
			this.report(channel, error);
		}
	}

	startDirectMessages(): Promise<void> {
		if (this.closing) return Promise.resolve();
		const channels = new Set(
			this.store
				.listInbox()
				.filter((message) => message.state !== "completed")
				.map((message) => message.channel)
				.filter(
					(channel) => !channel.startsWith("#") && !channel.startsWith("&"),
				),
		);
		return Promise.all(
			[...channels].map((channel) => this.startChannel(channel)),
		).then(() => {});
	}

	/** Called on IRC reconnect. A failed send stops this drain until the next explicit retry. */
	drainOutputs(): Promise<void> {
		if (this.closing) return Promise.resolve();
		if (this.outputWorker) return this.outputWorker;
		const work = this.runOutputs().catch((error) => this.report("", error));
		this.outputWorker = work;
		void work.finally(() => {
			if (this.outputWorker === work) this.outputWorker = undefined;
		});
		return work;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.finishClose();
		return this.closePromise;
	}

	/** Call only after close() and all harness adapters have closed their backing stores. */
	release(): void {
		if (!this.drained)
			throw new Error(
				"Durable IRC delivery must finish closing before releasing ownership",
			);
		this.store.close();
	}

	private kick(channel: string): void {
		if (this.closing || this.blocked.has(channel) || this.workers.has(channel))
			return;
		// Recovery must run first; newer messages cannot overtake an uncertain older operation.
		if (
			!this.store
				.listInbox("pending")
				.some((message) => message.channel === channel)
		)
			return;
		if (
			this.store
				.listInbox("recovery-required")
				.some((message) => message.channel === channel)
		)
			return;
		const work = this.runChannel(channel).catch((error) => {
			this.blocked.add(channel);
			this.report(channel, error);
		});
		this.workers.set(channel, work);
		void work.then(() => {
			if (this.workers.get(channel) === work) this.workers.delete(channel);
			if (
				!this.closing &&
				!this.blocked.has(channel) &&
				this.store
					.listInbox("pending")
					.some((message) => message.channel === channel)
			) {
				this.kick(channel);
			}
		});
	}

	private async runChannel(channel: string): Promise<void> {
		let activeId: string | undefined;
		try {
			const session = await this.handlers.open(channel);
			if (this.closing) {
				await session.abort();
				return;
			}
			this.sessions.set(channel, session);
			while (!this.closing) {
				const message = this.store.claimNext(channel);
				if (!message) return;
				activeId = message.id;
				this.activeMessages.set(channel, message);
				const result = await session.promptDurable(message.id, message.body);
				if (result.steered)
					throw new Error(
						"Durable inbox requires terminal prompt completion, not steering acceptance",
					);
				const answer = this.store.complete(
					message.id,
					toIrcLines(result.text).map((text, index) => ({
						id: `${message.id}/reply/${index}`,
						channel,
						text,
					})),
					result.text,
				);
				activeId = undefined;
				this.activeMessages.delete(channel);
				if (answer) this.kick(answer.channel);
				await this.drainOutputs();
			}
		} catch (error) {
			if (activeId) this.store.markRecoveryRequired(activeId);
			this.blocked.add(channel);
			this.report(channel, error);
		} finally {
			this.sessions.delete(channel);
			this.activeMessages.delete(channel);
		}
	}

	private async runOutputs(): Promise<void> {
		const failed = new Set<string>();
		while (!this.closing) {
			const next = this.store
				.listOutbox()
				.find(
					(message) =>
						message.state === "pending" &&
						!failed.has(message.channel) &&
						(this.handlers.canDeliver?.(message.channel) ?? true),
				);
			if (!next) return;
			const message = this.store.claimOutput(next.channel);
			if (!message) return;
			try {
				await this.handlers.deliver(message.channel, message.text);
				this.store.acknowledgeOutput(message.id);
			} catch (error) {
				this.store.retryOutput(message.id);
				this.report(message.channel, error);
				failed.add(message.channel);
			}
		}
	}

	private report(channel: string, error: unknown): void {
		try {
			this.handlers.report(channel, error);
		} catch {
			/* Reporting cannot break recovery or release ownership early. */
		}
	}

	private async finishClose(): Promise<void> {
		await Promise.allSettled(
			[...this.sessions.values()].map((session) => session.abort()),
		);
		await Promise.allSettled([...this.workers.values()]);
		if (this.outputWorker) await this.outputWorker;
		this.drained = true;
	}
}
