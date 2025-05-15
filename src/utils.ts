/** Returns a timestamp with nano-second precision */
export function highResTimestamp(): number {
	if (typeof process !== "undefined") {
		const [s, ns] = process.hrtime();
		return s * 1e9 + ns;
	} else if (performance != undefined) {
		return performance.now() * 1e6;
	} else {
		throw new Error("No high-resolution timer available");
	}
}

/** Does nothing. Can be used for empty `.catch(...)` calls. */
export function noop(): void {
	// intentionally empty
}

export type FnOrStatic<TArgs extends any[], TReturn> =
	| ((...args: TArgs) => TReturn)
	| TReturn;

export type ReturnTypeOrStatic<T> = T extends (...args: any[]) => infer R ? R
	: T;

export function evalOrStatic<T>(
	fnOrConst: T,
	...args: any[]
): ReturnTypeOrStatic<T> {
	// @ts-expect-error https://github.com/microsoft/TypeScript/issues/61337
	return typeof fnOrConst === "function" ? fnOrConst(...args) : fnOrConst;
}
