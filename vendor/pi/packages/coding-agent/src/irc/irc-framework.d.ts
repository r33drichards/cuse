/** Minimal typings for the parts of irc-framework the IRC presentation uses. */
declare module "irc-framework" {
	export interface IrcConnectOptions {
		host: string;
		port: number;
		tls?: boolean;
		rejectUnauthorized?: boolean;
		nick: string;
		username?: string;
		gecos?: string;
		password?: string;
		auto_reconnect?: boolean;
		auto_reconnect_max_retries?: number;
		auto_reconnect_max_wait?: number;
		ping_interval?: number;
		ping_timeout?: number;
		message_max_length?: number;
	}
	export interface IrcPrivmsgEvent {
		from_server: boolean;
		nick: string;
		ident: string;
		hostname: string;
		target: string;
		message: string;
		tags: Record<string, string>;
		time?: number;
	}
	export interface IrcRegisteredEvent {
		nick: string;
	}
	export class Client {
		user: { nick: string };
		connected: boolean;
		connect(options: IrcConnectOptions): void;
		join(channel: string, key?: string): void;
		part(channel: string, message?: string): void;
		say(target: string, message: string, tags?: Record<string, string>): void;
		notice(target: string, message: string): void;
		quit(message?: string): void;
		changeNick(nick: string): void;
		raw(...args: (string | number)[]): void;
		on(event: "registered", handler: (event: IrcRegisteredEvent) => void): this;
		on(event: "privmsg", handler: (event: IrcPrivmsgEvent) => void): this;
		on(event: "nick in use", handler: (event: { nick: string; reason: string }) => void): this;
		on(event: "close", handler: (error: boolean) => void): this;
		on(event: "reconnecting", handler: (event: { attempt: number; max_retries: number; wait: number }) => void): this;
		on(event: "socket close", handler: (error: unknown) => void): this;
		on(event: "join", handler: (event: { channel: string; nick: string }) => void): this;
		on(event: "part", handler: (event: { channel: string; nick: string; message?: string }) => void): this;
		on(
			event: "kick",
			handler: (event: { channel: string; nick: string; kicked: string; message?: string }) => void,
		): this;
		on(event: "irc error", handler: (event: { error: string; reason?: string; channel?: string }) => void): this;
		on(event: string, handler: (...args: unknown[]) => void): this;
	}
}
