/**
 * Which channel a background failure came from.
 *
 * pi's session runtime assumes one session per process. The bot runs one per
 * channel, so an extension can hold a context from its own session and throw
 * against it later — from a widget's refresh timer, say — long after the call
 * that created the timer returned. Such a throw reaches the process as an
 * uncaught exception with nothing to say which channel it belongs to.
 *
 * Work a channel does runs inside a domain named after it, and timers created
 * there keep it. Callbacks are *not* wrapped in try/catch: swallowing an
 * exception that the runtime expects to propagate can leave a promise
 * unsettled and hang the session. This only records who was running, so the
 * process-level handler can name the channel and leave everything else alone.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();
/** The domain whose timer callback is on the stack right now. */
let running: string | undefined;
let installed = 0;

/** The channel whose work is running right now, if any. */
export function currentDomain(): string | undefined {
	return storage.getStore();
}

/**
 * The channel whose timer callback was running when the process last lost an
 * exception. Undefined when the failure came from outside any channel.
 */
export function faultingDomain(): string | undefined {
	return running;
}

/** Forget the recorded channel once a failure has been attributed to it. */
export function clearFaultingDomain(): void {
	running = undefined;
}

/** Run `fn`, and anything it schedules, as `channel`'s work. */
export function runInDomain<T>(channel: string, fn: () => T): T {
	return storage.run(channel, fn);
}

type TimerFn = typeof setTimeout;

function patchTimer(original: TimerFn): TimerFn {
	const patched = ((callback: unknown, ms?: number, ...args: unknown[]) => {
		const channel = storage.getStore();
		if (channel === undefined || typeof callback !== "function") {
			return (original as (...a: unknown[]) => unknown)(callback, ms, ...args);
		}
		const inner = callback as (...a: unknown[]) => void;
		const wrapped = (...callbackArgs: unknown[]) => {
			const previous = running;
			running = channel;
			try {
				// Inside the domain, so timers this callback arms keep it too.
				storage.run(channel, () => inner(...callbackArgs));
			} catch (error) {
				// `uncaughtException` runs after this stack unwinds, so the
				// channel has to stay recorded until the handler reads it. The
				// throw is passed on untouched.
				running = channel;
				throw error;
			}
			running = previous;
		};
		return (original as (...a: unknown[]) => unknown)(wrapped, ms, ...args);
	}) as unknown as TimerFn;
	Object.assign(patched, original);
	return patched;
}

/**
 * Start attributing timer failures to channels. Returns a function that puts
 * the original timers back.
 */
export function installFaultDomains(): () => void {
	installed += 1;
	if (installed > 1) {
		return () => {
			installed -= 1;
		};
	}
	const realSetTimeout = globalThis.setTimeout;
	const realSetInterval = globalThis.setInterval;
	const realSetImmediate = globalThis.setImmediate;
	globalThis.setTimeout = patchTimer(realSetTimeout);
	globalThis.setInterval = patchTimer(realSetInterval as unknown as TimerFn) as unknown as typeof setInterval;
	globalThis.setImmediate = patchTimer(realSetImmediate as unknown as TimerFn) as unknown as typeof setImmediate;
	return () => {
		installed -= 1;
		if (installed > 0) return;
		globalThis.setTimeout = realSetTimeout;
		globalThis.setInterval = realSetInterval;
		globalThis.setImmediate = realSetImmediate;
		running = undefined;
	};
}
