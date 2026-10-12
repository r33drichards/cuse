/**
 * Short memorable channel suffixes for `,fork` without a target:
 * `#clone` forks into `#clone-brave-otter`. Names come from `node-petname`
 * (the Node port of Dustin Kirkland's petname: adjective-name words); the
 * caller retries on collisions.
 */

import generate from "node-petname";

/** A two-word `adjective-name` petname, lower case, IRC-safe. */
export function petname(): string {
	return generate(2, "-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "");
}

/**
 * `#<base>-<petname>` that `taken` does not reject, retrying a bounded number
 * of times before giving up with an error. A base that already carries a
 * petname suffix (a fork of a fork) keeps only its original name.
 */
export function forkChannelName(
	base: string,
	taken: (channel: string) => boolean,
	options: { generate?: () => string; attempts?: number } = {},
): string {
	const attempts = options.attempts ?? 8;
	const next = options.generate ?? petname;
	const prefix = base.replace(/-[a-z]+-[a-z]+$/, "");
	for (let i = 0; i < attempts; i += 1) {
		const candidate = `${prefix}-${next()}`;
		if (!taken(candidate)) return candidate;
	}
	throw new Error(`could not find a free channel name for ${base} after ${attempts} attempts`);
}
