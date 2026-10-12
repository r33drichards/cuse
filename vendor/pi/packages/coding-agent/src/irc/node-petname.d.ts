declare module "node-petname" {
	/** Generate a random pet name of `words` words joined by `separator` (default "-"). */
	function petname(words?: number, separator?: string): string;
	export = petname;
}
