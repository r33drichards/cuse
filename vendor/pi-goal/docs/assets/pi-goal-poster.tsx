export default () => {
	const dim = "text-neutral-500";
	const text = "text-neutral-800";
	const accent = "text-neutral-900";
	const muted = "text-neutral-400";

	const Line = ({ children }: { children: React.ReactNode }) => (
		<div className="font-mono text-[14px] leading-[1.6] whitespace-pre">{children}</div>
	);

	return (
		<div className="w-[1280px] bg-neutral-100 p-12 font-sans">
			<div className="overflow-hidden rounded-xl border border-neutral-300 bg-white">
				{/* Title bar */}
				<div className="flex items-center justify-between border-b border-neutral-300 bg-neutral-50 px-4 py-1.5">
					<div className="flex items-center gap-2">
						<span className="block h-3 w-3 rounded-full bg-[#ff5f57]" />
						<span className="block h-3 w-3 rounded-full bg-[#febc2e]" />
						<span className="block h-3 w-3 rounded-full bg-[#28c840]" />
					</div>
					<div className="font-mono text-[11px] tracking-[0.15em] text-neutral-400">
						~/pi-goal
					</div>
					<div className="font-mono text-[11px] text-neutral-300">v0.1.2</div>
				</div>

				{/* Terminal body */}
				<div className="px-7 py-6">
					<Line>
						<span className={muted}>michael@studio</span>
						<span className={dim}> ~/pi-goal </span>
						<span className={accent}>$</span>{" "}
						<span className={text}>pi install npm:pi-goal</span>
					</Line>
					<Line>
						<span className={dim}>installed pi-goal · ready</span>
					</Line>
					<div className="h-3" />
					<Line>
						<span className={accent}>›</span>{" "}
						<span className={text}>/goal improve benchmark coverage --tokens 50k</span>
					</Line>
					<div className="h-2" />
					<div className="border-l-2 border-neutral-300 pl-3">
						<Line>
							<span className={accent}>Goal</span>{" "}
							<span className={dim}>active (ctrl+o to expand)</span>
						</Line>
					</div>
					<div className="h-1.5" />
					<div className="border-l-2 border-neutral-200 pl-3">
						<Line>
							<span className={accent}>Goal</span>{" "}
							<span className={dim}>continuing (ctrl+o to expand)</span>
						</Line>
					</div>
					<div className="h-1.5" />
					<div className="border-l-2 border-neutral-200 pl-3">
						<Line>
							<span className={accent}>Goal</span>{" "}
							<span className={dim}>continuing (ctrl+o to expand)</span>
						</Line>
					</div>
					<div className="h-1.5" />
					<div className="border-l-2 border-neutral-900 pl-3">
						<Line>
							<span className={accent}>Goal</span>{" "}
							<span className={text}>achieved </span>
							<span className={dim}>(33s)</span>
						</Line>
					</div>
					<div className="h-3" />
					<Line>
						<span className={accent}>›</span>
						<span className="inline-block w-[8px] h-[15px] bg-neutral-900 align-[-2px] ml-[2px] animate-pulse" />
					</Line>
				</div>

				{/* Footer / status bar */}
				<div className="flex items-center justify-between border-t border-neutral-300 bg-neutral-50 px-4 py-1 font-mono text-[11px] text-neutral-500">
					<div>Pursuing goal (33s)</div>
					<div className="tracking-[0.15em] text-neutral-400">github.com/Michaelliv/pi-goal</div>
				</div>
			</div>

			{/* Caption */}
			<div className="mt-8 flex items-end justify-between">
				<div>
					<div className="font-sans text-[60px] leading-none font-black tracking-tight text-neutral-900">
						pi-goal
					</div>
					<div className="mt-2 font-sans text-[18px] text-neutral-600">
						Codex-style persistent goals for pi.
					</div>
				</div>
				<div className="text-right font-mono text-[12px] text-neutral-500">
					<div>/goal &lt;objective&gt;</div>
					<div>/goal pause · resume · clear</div>
					<div>/goal statusbar on|off</div>
				</div>
			</div>
		</div>
	);
};
