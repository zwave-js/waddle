import {
	type CompareResult,
	compareNumberOrString,
} from "alcalzone-shared/comparable";
import {
	type DeferredPromise,
	createDeferredPromise,
} from "alcalzone-shared/deferred-promise";
import { SortedList } from "alcalzone-shared/sorted-list";
import { createWrappingCounter } from "./wrappingCounter.js";
import { evalOrStatic, highResTimestamp, noop } from "./utils.js";

/** The read-only view of a task that gets passed to its own task function */
export interface TaskHandle<TaskTag extends { id: string } = { id: string }> {
	readonly id: number;
	readonly timestamp: number;

	/** The parent task spawning this subtask, if any */
	readonly parent?: TaskHandle<TaskTag>;

	/** A name to identify the task */
	readonly name?: string;
	/** A tag to identify the task programmatically */
	readonly tag?: TaskTag;
	/** The task's priority */
	readonly priority: TaskPriority;
	/** The concurrency group this task belongs to */
	readonly group?: TaskConcurrencyGroup;
	/** How the task should behave when interrupted */
	readonly interrupt: TaskInterruptBehavior;
	/** The current state of the task */
	get state(): TaskState;
}

/** A high-level task that can be started and stepped through */
export interface Task<
	TReturn,
	TaskTag extends { id: string } = { id: string },
	TError extends Error = Error,
> extends TaskHandle<TaskTag> {
	readonly builder: TaskBuilder<TReturn, TaskTag>;

	/** The parent task spawning this subtask, if any */
	readonly parent?: Task<unknown, TaskTag, TError>;

	/** Starts the task it if hasn't been started yet, and executes the next step of the task */
	step(): Promise<TaskStepResult<TReturn, TaskTag>>;
	/** Stops the task without further executing it, cleans up, and prepares it for starting again */
	reset(): Promise<void>;
	/** Resolves the task's promise to notify the caller */
	resolve(result: TReturn): void;
	/** Rejects the task's promise to notify the caller */
	reject(error: TError): void;

	readonly generator: ReturnType<TaskBuilder<TReturn>["task"]> | undefined;
	readonly promise: Promise<TReturn>;
}

function getTaskName(task: Task<unknown>): string {
	let name = task.name;
	if (name == undefined && task.tag) {
		// The tag may contain values JSON cannot serialize, like a BigInt
		try {
			name = JSON.stringify(task.tag);
		} catch {
			name = task.tag.id;
		}
	}
	return `${name ?? "unnamed"} (ID ${task.id})`;
}

/** Defines the necessary information for creating a task */
export interface TaskBuilder<
	TReturn,
	TaskTag extends { id: string } = { id: string },
	TInner = unknown,
> {
	/** A name to identify the task */
	name?: string;
	/** A tag to identify the task programmatically */
	tag?: TaskTag;
	/** The task's priority */
	priority: TaskPriority;
	/** How the task should behave when interrupted */
	interrupt?: TaskInterruptBehavior;
	/** The concurrency group this task belongs to */
	group?: TaskConcurrencyGroup;
	/**
	 * The task's main generator function. This is called repeatedly until it's done.
	 * The function must yield at points where it may be interrupted.
	 *
	 * At those points, the task can also wait for something to happen:
	 * - Either a Promise, in which case it must yield a function that returns that Promise
	 * - Or another task, in which case it must yield a TaskBuilder object or a function that returns one
	 *
	 * Yielded Promises should not spawn new tasks. If they do, the spawned tasks MUST have a higher priority than the parent task.
	 * They also MUST NOT wait for a concurrency group that the parent task or a task with a lower priority holds.
	 * Such a task could not run during the wait, so `queueTask` throws and the parent task fails.
	 * A `Forbidden` or `Restart` task MUST NOT yield such a Promise. A `Forbidden` task keeps the spawned task from running,
	 * and a `Restart` task is restarted every time the spawned task runs.
	 *
	 * Yielding a TaskBuilder throws an error at the `yield` when the subtask would wait forever.
	 * Example: The subtask is in a concurrency group whose holder this task holds back.
	 *
	 * @param thisTask The task that runs this function. It is the same object the scheduler passes to `removeTasks` predicates,
	 * so it can be compared by identity. It stays the same when the task gets restarted.
	 */
	task: (
		thisTask: TaskHandle,
	) => AsyncGenerator<
		| (() => Promise<unknown> | TaskBuilder<unknown, TaskTag, unknown>)
		| (() => TaskBuilder<unknown, TaskTag, unknown>)
		| TaskBuilder<unknown, TaskTag, unknown>
		| undefined,
		TReturn,
		TInner
	>;
	/** A cleanup function that gets called when the task is dropped */
	cleanup?: () => Promise<void>;
}

export type TaskReturnType<T extends TaskBuilder<unknown>> =
	T extends TaskBuilder<infer R> ? R : never;

/** Returns whether `parent` is `task` itself or one of the tasks waiting for it */
function isSameOrParentOf<TaskTag extends { id: string }>(
	parent: Task<unknown, TaskTag>,
	task: Task<unknown, TaskTag>,
): boolean {
	for (const t of selfAndParents(task)) {
		if (t === parent) return true;
	}
	return false;
}

/** Returns whether one of the tasks is the other one or waits for it, directly or through other tasks */
function inSameChain<TaskTag extends { id: string }>(
	a: Task<unknown, TaskTag>,
	b: Task<unknown, TaskTag>,
): boolean {
	return isSameOrParentOf(a, b) || isSameOrParentOf(b, a);
}

/** Returns whether the started `Restart` or `Forbidden` task `holder` holds `task` back */
function holdsBack<TaskTag extends { id: string }>(
	holder: Task<unknown, TaskTag>,
	task: Task<unknown, TaskTag>,
): boolean {
	// A task never holds back a task it waits for, or a task that waits for it
	if (inSameChain(holder, task)) return false;
	// A Forbidden task holds back all other tasks. A Restart task holds back the tasks with its priority.
	return (
		holder.interrupt === TaskInterruptBehavior.Forbidden ||
		holder.priority === task.priority
	);
}

/** Yields the given task, then each task waiting for it, up to the outermost one */
function* selfAndParents<TaskTag extends { id: string }>(
	task: Task<unknown, TaskTag>,
): Generator<Task<unknown, TaskTag>> {
	for (let t: Task<unknown, TaskTag> | undefined = task; t; t = t.parent) {
		yield t;
	}
}

function isTaskBuilder<T>(obj: any): obj is TaskBuilder<T> {
	return (
		typeof obj === "object" &&
		typeof obj.task === "function" &&
		typeof obj.priority === "number"
	);
}

/**
 * The priority of a task.
 *
 * Higher priority tasks are executed first and interrupt lower priority tasks.
 * The recommended priority for application-initiated communication is `Normal`.
 * `Low` and `Lower` are recommended for internal long-running tasks that should not interfere with user-initiated tasks.
 * `Idle` is recommended for tasks that should only run when no other tasks are pending.
 */
export enum TaskPriority {
	Highest,
	High = 1,
	Normal = 2,
	Low = 3,
	Lower = 4,
	Idle = 5,
}

export enum TaskState {
	/** The task has not been created yet */
	None,
	/** The task is being executed */
	Active,
	/** The task is waiting for a Promise to resolve */
	AwaitingPromise,
	/** The task is waiting for another task to finish */
	AwaitingTask,
	/** The task is finished */
	Done,
}

export enum TaskInterruptBehavior {
	/** The task may not be interrupted */
	Forbidden,
	/** The task will be resumed after being interrupted (default) */
	Resume,
	/** The task needs to be restarted after being interrupted */
	Restart,
}

export type TaskStepResult<
	T,
	TaskTag extends { id: string } = { id: string },
> =
	| {
			newState: TaskState.Done;
			result: T;
	  }
	| {
			newState: TaskState.Active;
	  }
	| {
			// The task was reset while the step was in flight. The result is stale and must be dropped.
			newState: TaskState.None;
	  }
	| {
			newState: TaskState.AwaitingPromise;
			promise: Promise<unknown>;
	  }
	| {
			newState: TaskState.AwaitingTask;
			task: Task<unknown, TaskTag>;
	  };

/** Identifies a concurrency group. Tasks within the same group cannot run concurrently. */
export interface TaskConcurrencyGroup {
	id: string;
}

/** Returns the task whose turn the given task takes. A subtask shares the turn of the outermost parent with the same priority. */
function getTurnOwner<TaskTag extends { id: string }>(
	task: Task<unknown, TaskTag>,
): Task<unknown, TaskTag> {
	let ret = task;
	while (ret.parent && ret.parent.priority === task.priority) {
		ret = ret.parent;
	}
	return ret;
}

export class TaskScheduler<
	TaskTag extends { id: string } = { id: string },
	TError extends Error = Error,
> {
	public constructor(
		private defaultErrorFactory: () => TError = () =>
			new Error("Task was removed") as any,
		private verbose: boolean = false,
	) {}

	private _tasks = new SortedList<Task<unknown, TaskTag>>(undefined, (a, b) =>
		this.compareTasks(a, b),
	);
	private _currentTask: Task<unknown, TaskTag> | undefined;
	/** The promises that queued tasks wait for, until they settle */
	private _awaitedPromises = new Map<
		Task<unknown, TaskTag>,
		Promise<unknown>
	>();
	/** The started `Restart` and `Forbidden` tasks that hold back other tasks until they are done */
	private _holders = new Set<Task<unknown, TaskTag>>();
	/** The task whose yielded promise factory is being called right now */
	private _spawningTask: Task<unknown, TaskTag> | undefined;
	/** The order in which the turn owners of tasks with the same priority take their next turn */
	private _turns = new WeakMap<Task<unknown, TaskTag>, number>();
	private _turnCounter = 0;

	private _idGenerator = createWrappingCounter(0xff_ff_ff);
	private _continueSignal: DeferredPromise<void> | undefined;
	private _stopSignal: DeferredPromise<void> | undefined;
	private _stopPromise: DeferredPromise<void> | undefined;

	/**
	 * Sorts tasks by priority, then by the order in which they take their next turn.
	 * The comparison must only use values that do not change while a task is queued.
	 * Whether a task may run right now is decided when the next task gets picked.
	 */
	private compareTasks(
		a: Task<unknown, TaskTag>,
		b: Task<unknown, TaskTag>,
	): CompareResult {
		return (
			compareNumberOrString(a.priority, b.priority) ||
			compareNumberOrString(
				this._turns.get(getTurnOwner(a))!,
				this._turns.get(getTurnOwner(b))!,
			) ||
			compareNumberOrString(a.id, b.id)
		);
	}

	/**
	 * Gives the turn owner of a task the next turn number, which sorts it behind all queued tasks with the same priority.
	 * Call this only while no task with that turn owner is queued.
	 */
	private assignNextTurn(task: Task<unknown, TaskTag>): void {
		this._turns.set(getTurnOwner(task), ++this._turnCounter);
	}

	/** Moves a queued task behind the other queued tasks with its priority, so tasks with the same priority take turns */
	private endTurn(task: Task<unknown, TaskTag>): void {
		this._tasks.remove(task);
		this.assignNextTurn(task);
		this._tasks.add(task);
	}

	public queueTask<T>(builder: TaskBuilder<T, TaskTag>): Promise<T> {
		const task = this.createTask(builder);
		if (this._spawningTask) {
			this.assertRunsWhileSpawnerWaits(task, this._spawningTask);
		}
		this.assignNextTurn(task);
		this._tasks.add(task);
		if (this.verbose) {
			console.log(`Task queued: ${getTaskName(task)}`);
		}

		if (this._continueSignal) this._continueSignal.resolve();
		return task.promise;
	}

	/**
	 * Removes/stops tasks matching the given predicate. Returns `true` when a task was removed, `false` otherwise.
	 *
	 * The predicate also sees parent tasks that are waiting for a subtask.
	 * Removing such a parent also removes the subtasks it is waiting for.
	 */
	public async removeTasks(
		predicate: (task: Task<unknown, TaskTag>) => boolean,
		reason?: TError,
	): Promise<boolean> {
		// Collect tasks that should be removed, so that we handle the current task last.
		// Each queued task is the end of a chain of parents waiting for it.
		const tasksToRemove = new Set<Task<unknown, TaskTag>>();
		const currentTasksToRemove: Task<unknown, TaskTag>[] = [];
		for (const queued of this._tasks) {
			for (const task of selfAndParents(queued)) {
				if (!predicate(task)) continue;
				if (queued === this._currentTask) {
					currentTasksToRemove.push(task);
				} else {
					tasksToRemove.add(task);
				}
			}
		}
		for (const task of currentTasksToRemove) {
			tasksToRemove.add(task);
		}

		reason ??= this.defaultErrorFactory();

		for (const task of tasksToRemove) {
			// Skip tasks the run loop finalized or that were dropped with an earlier chain
			const leaf = this.findLeafTask(task);
			if (!leaf) continue;

			// Drop everything from the leaf up to the outermost matching parent
			let outermost = task;
			for (let t = task.parent; t; t = t.parent) {
				if (tasksToRemove.has(t)) outermost = t;
			}
			await this.dropTasks(leaf, outermost, reason);
		}

		if (this._continueSignal) this._continueSignal.resolve();

		return tasksToRemove.size > 0;
	}

	/** Yields the current task and the queued tasks. Each is the end of a chain of parents waiting for it. */
	private *leafTasks(): Generator<Task<unknown, TaskTag>> {
		if (this._currentTask) yield this._currentTask;
		yield* this._tasks;
	}

	/** Returns the queued or current task that is `task` itself or one of its subtasks, if any */
	private findLeafTask(
		task: Task<unknown, TaskTag>,
	): Task<unknown, TaskTag> | undefined {
		for (const leaf of this.leafTasks()) {
			if (isSameOrParentOf(task, leaf)) return leaf;
		}
	}

	/**
	 * Removes `leaf` from the queue, then resets and rejects it and each of its parents up to and including `outermost`.
	 * The parent of `outermost` is put back into the queue first.
	 */
	private async dropTasks(
		leaf: Task<unknown, TaskTag>,
		outermost: Task<unknown, TaskTag>,
		reason: TError,
	): Promise<void> {
		this._tasks.remove(leaf);
		// Claim the task before awaiting anything, so the run loop drops the
		// result of an in-flight step instead of finalizing the task a second time
		if (this._currentTask === leaf) {
			this._currentTask = undefined;
		}
		for (let task = leaf; ; task = task.parent!) {
			this.releaseHolds(task);
			if (task === outermost) break;
		}
		if (outermost.parent) this.restoreParentTask(outermost.parent);
		for (let task = leaf; ; task = task.parent!) {
			if (this.verbose) {
				console.log(`Removing task: ${getTaskName(task)}`);
			}
			await task.reset().catch(noop);
			task.reject(reason);
			if (task === outermost) break;
		}
	}

	/**
	 * Puts a parent back into the queue when its subtask is finished or removed.
	 * Call this before cleaning up the subtask, so the parent can be found during the cleanup.
	 */
	private restoreParentTask(parent: Task<unknown, TaskTag>): void {
		if (this.verbose) {
			console.log(`Restoring parent task: ${getTaskName(parent)}`);
		}
		this._tasks.add(parent);
	}

	/** Forgets the promise a task waits for and releases its `Restart` or `Forbidden` hold */
	private releaseHolds(task: Task<unknown, TaskTag>): void {
		this._awaitedPromises.delete(task);
		this._holders.delete(task);
	}

	/**
	 * Records the promise a task waits for.
	 * `pickNextTask` skips the task until the promise settles, and the run loop then wakes up.
	 */
	private trackWaitingTask(
		task: Task<unknown, TaskTag>,
		promise: Promise<unknown>,
	): void {
		this._awaitedPromises.set(task, promise);
		const settled = () => {
			// Ignore the promise if the task was reset or removed in the meantime
			if (this._awaitedPromises.get(task) !== promise) return;
			this._awaitedPromises.delete(task);
			this._continueSignal?.resolve();
		};
		promise.then(settled, settled);
	}

	/**
	 * Returns the started task that holds the concurrency group of `task`, if any.
	 * Tasks that `task` waits for, and tasks that wait for `task`, do not count.
	 */
	private findGroupHolder(
		task: Task<unknown, TaskTag>,
	): Task<unknown, TaskTag> | undefined {
		const groupId = task.group?.id;
		if (!groupId) return;
		for (const leaf of this.leafTasks()) {
			// `task` may be a subtask that is not queued yet. Then its parent is queued in its place.
			if (inSameChain(leaf, task)) continue;
			for (const t of selfAndParents(leaf)) {
				// A started task holds its group until it is done, also while it waits for a subtask
				if (t.state !== TaskState.None && t.group?.id === groupId) {
					return t;
				}
			}
		}
	}

	/** Returns whether a started task other than `task` and its parents holds `task` back */
	private isHeldBack(task: Task<unknown, TaskTag>): boolean {
		for (const holder of this._holders) {
			if (holdsBack(holder, task)) return true;
		}
		return false;
	}

	/**
	 * Throws when `task` could not run while `spawner` waits for the promise whose factory queued `task`.
	 * While `spawner` waits, tasks with a lower priority do not run, and neither does the chain of `spawner`.
	 */
	private assertRunsWhileSpawnerWaits(
		task: Task<unknown, TaskTag>,
		spawner: Task<unknown, TaskTag>,
	): void {
		const holder = this.findGroupHolder(task);
		if (!holder) return;
		if (
			holder.priority <= spawner.priority &&
			!inSameChain(holder, spawner)
		) {
			return;
		}
		throw new Error(
			`Cannot queue ${getTaskName(task)} while ${getTaskName(spawner)} waits for a promise: ${getTaskName(holder)} must finish before ${getTaskName(task)} can run, because both are in concurrency group "${task.group!.id}", but ${getTaskName(holder)} does not run before ${getTaskName(spawner)} continues.`,
		);
	}

	/** Yields the started tasks that must finish before `task` may run, each with the reason */
	private *findBlockers(
		task: Task<unknown, TaskTag>,
	): Generator<[blocker: Task<unknown, TaskTag>, reason: string]> {
		const groupHolder = this.findGroupHolder(task);
		if (groupHolder) {
			yield [
				groupHolder,
				`${getTaskName(groupHolder)} must finish before ${getTaskName(task)} can run, because both are in concurrency group "${task.group!.id}"`,
			];
		}
		for (const holder of this._holders) {
			if (!holdsBack(holder, task)) continue;
			const why =
				holder.interrupt === TaskInterruptBehavior.Forbidden
					? "it must not be interrupted"
					: "it starts over when interrupted";
			yield [
				holder,
				`${getTaskName(holder)} must finish before ${getTaskName(task)} can run, because ${why}`,
			];
		}
	}

	/**
	 * Returns the reasons why `subtask` would wait forever, if a chain of waits leads from it back to its parent.
	 * Call this before queueing `subtask`, while its parent is still the leaf of its chain.
	 *
	 * Example: Forbidden task F spawns subtask S in group G. Task A holds G, and F holds A back.
	 * Then S waits for A, and A waits for F.
	 */
	private findDeadlock(
		subtask: Task<unknown, TaskTag>,
	): string[] | undefined {
		const parent = subtask.parent!;
		const visited = new Set<Task<unknown, TaskTag>>();
		const visit = (task: Task<unknown, TaskTag>): string[] | undefined => {
			for (const [blocker, reason] of this.findBlockers(task)) {
				if (isSameOrParentOf(blocker, parent)) return [reason];
				if (visited.has(blocker)) continue;
				visited.add(blocker);
				// The blocker is done only after the leaf of its chain and each task up to the blocker ran
				const leaf = this.findLeafTask(blocker);
				if (!leaf) continue;
				for (const t of selfAndParents(leaf)) {
					const reasons = visit(t);
					if (reasons) return [reason, ...reasons];
					if (t === blocker) break;
				}
			}
		};
		return visit(subtask);
	}

	/** Returns the queued task that may take the next step, other than `skip` */
	private pickNextTask(
		skip?: Task<unknown, TaskTag>,
	): Task<unknown, TaskTag> | undefined {
		let floorPriority: TaskPriority | undefined;
		for (const task of this._tasks) {
			if (task === skip) continue;
			// While a task waits for a promise, tasks with a lower priority may not run.
			// The queue is sorted by priority, so no later task may run either.
			if (floorPriority != undefined && task.priority > floorPriority) {
				return;
			}
			if (this.isHeldBack(task)) continue;
			if (this.findGroupHolder(task)) continue;
			if (this._awaitedPromises.has(task)) {
				floorPriority ??= task.priority;
				continue;
			}
			return task;
		}
	}

	/**
	 * Returns the promise of the first task matching the given predicate, if any.
	 * The predicate also sees parent tasks that are waiting for a subtask.
	 */
	public findTask<T = unknown>(
		predicate: (task: Task<T, TaskTag>) => boolean,
	): Promise<T> | undefined {
		for (const queued of this._tasks) {
			for (const task of selfAndParents(queued)) {
				if (predicate(task as Task<T, TaskTag>)) {
					return task.promise as Promise<T>;
				}
			}
		}
	}

	/** Creates a task that can be executed */
	private createTask<T>(
		builder: TaskBuilder<T, TaskTag>,
		parent?: Task<unknown, TaskTag>,
	): Task<T, TaskTag, TError> {
		let state = TaskState.None;
		let generator: ReturnType<TaskBuilder<T, TaskTag>["task"]> | undefined;
		let waitForPromise: Promise<unknown> | undefined;
		const promise = createDeferredPromise<T>();

		let prevResult: unknown;
		let waitError: unknown;

		const self = this;

		const task: Task<T, TaskTag, TError> = {
			id: this._idGenerator(),
			timestamp: highResTimestamp(),
			builder,
			parent,
			name: builder.name,
			tag: builder.tag,
			priority: builder.priority,
			group: builder.group,
			interrupt: builder.interrupt ?? TaskInterruptBehavior.Resume,
			promise,
			async step() {
				// Do not proceed while still waiting for a Promise to resolve
				if (state === TaskState.AwaitingPromise && waitForPromise) {
					return {
						newState: state,
						promise: waitForPromise,
					};
				} else if (state === TaskState.AwaitingTask) {
					// A parent can be queued before it has received the subtask's result.
					// This happens while its finished subtask is cleaned up, and when the scheduler rejects the subtask without queueing it.
					// The parent must wait until it has received the result.
					if (waitForPromise) {
						return {
							newState: TaskState.AwaitingPromise,
							promise: waitForPromise,
						};
					}
					throw new Error(
						"Cannot step through a task that is waiting for another task",
					);
				}

				generator ??= builder.task(task);
				state = TaskState.Active;

				// Capture the generator so a concurrent reset() can be detected after the await
				const gen = generator;
				let genResult: Awaited<ReturnType<typeof gen.next>>;
				try {
					genResult = waitError
						? await gen.throw(waitError)
						: await gen.next(prevResult);
				} catch (e) {
					// Drop errors from a step whose task was reset in the meantime
					if (generator !== gen) return { newState: TaskState.None };
					throw e;
				}
				// Drop the step result if the task was reset while the generator was running,
				// so the task state is not corrupted after the reset
				if (generator !== gen) return { newState: TaskState.None };

				const { value, done } = genResult;
				prevResult = undefined;
				waitError = undefined;
				if (done) {
					state = TaskState.Done;
					return {
						newState: state,
						result: value,
					};
				} else if (value != undefined) {
					let waitFor;
					// Let queueTask check tasks that the promise factory queues
					self._spawningTask = task;
					try {
						waitFor = evalOrStatic(value);
					} finally {
						self._spawningTask = undefined;
					}
					if (waitFor instanceof Promise) {
						state = TaskState.AwaitingPromise;
						// Ignore the promise's result if this task was reset in the meantime
						waitForPromise = waitFor
							.then((result) => {
								if (generator === gen) prevResult = result;
							})
							.catch((e) => {
								if (generator === gen) waitError = e;
							})
							.finally(() => {
								if (generator !== gen) return;
								waitForPromise = undefined;
								if (state === TaskState.AwaitingPromise) {
									state = TaskState.Active;
								}
							});
						return {
							newState: state,
							promise: waitForPromise,
						};
					} else if (isTaskBuilder(waitFor)) {
						if (waitFor.priority > builder.priority) {
							throw new Error(
								"Tasks cannot yield to tasks with lower priority than their own",
							);
						}
						// Create a sub-task with a reference to this task
						state = TaskState.AwaitingTask;
						const subTask = self.createTask(waitFor, this);

						// Ignore the subtask's result if this task was reset in the meantime
						waitForPromise = subTask.promise
							.then((result) => {
								if (generator === gen) prevResult = result;
							})
							.catch((e) => {
								if (generator === gen) waitError = e;
							})
							.finally(() => {
								if (generator !== gen) return;
								waitForPromise = undefined;
								if (state === TaskState.AwaitingTask) {
									state = TaskState.Active;
								}
							});

						return {
							newState: state,
							task: subTask,
						};
					} else {
						throw new Error("Invalid value yielded by task");
					}
				} else {
					return { newState: state };
				}
			},
			async reset() {
				if (state === TaskState.None) return;
				state = TaskState.None;
				waitForPromise = undefined;
				generator = undefined;
				prevResult = undefined;
				waitError = undefined;

				await builder.cleanup?.();
			},
			resolve(result) {
				promise.resolve(result);
			},
			reject(error) {
				promise.reject(error);
			},
			get state() {
				return state;
			},
			get generator() {
				return generator;
			},
		};
		return task;
	}

	public start(): void {
		this._stopSignal = createDeferredPromise();
		// A timer instead of setImmediate, which only exists on Node.js and its clones
		setTimeout(async () => {
			try {
				await this.run();
			} catch (e) {
				console.error("Task runner crashed", e);
			}
		}, 0);
	}

	private async run(): Promise<void> {
		while (true) {
			const task = this.pickNextTask();
			if (task) {
				// A task with a higher priority interrupts the current task, also while it waits
				if (
					this._currentTask &&
					this._currentTask !== task &&
					this._currentTask.interrupt ===
						TaskInterruptBehavior.Restart &&
					task.priority < this._currentTask.priority
				) {
					// The current task needs to be restarted after being interrupted, so reset it
					const interrupted = this._currentTask;
					this.releaseHolds(interrupted);
					await interrupted.reset();
					// Re-evaluate the queue if it changed during the reset.
					// The reset task must be skipped, because it no longer waits and could be picked again.
					const repicked = this.pickNextTask(interrupted);
					if (
						this._currentTask !== interrupted ||
						repicked !== task
					) {
						continue;
					}
				}
				this._currentTask = task;

				if (this.verbose) {
					console.log(`Stepping through task: ${getTaskName(task)}`);
				}

				// A started Restart or Forbidden task holds back other tasks until it is done
				if (task.interrupt !== TaskInterruptBehavior.Resume) {
					this._holders.add(task);
				}

				const finalizeCurrentTask = async () => {
					this._tasks.remove(task);
					this.releaseHolds(task);
					// Claim the task before awaiting, so a concurrent removeTasks() skips it
					this._currentTask = undefined;
					if (task.parent) this.restoreParentTask(task.parent);
					await task.reset();
				};

				// Execute the current task one step further
				let stepResult: TaskStepResult<unknown, TaskTag>;
				try {
					stepResult = await task.step();
				} catch (e) {
					// Drop the error if the task was removed during the step. It was already rejected.
					if (this._currentTask !== task) continue;

					if (this.verbose) {
						console.error(`- Task threw an error:`, e);
					}
					// The task threw an error, expose the result and clean up.
					task.reject(e as Error);
					await finalizeCurrentTask();
					// Then continue with the next iteration
					continue;
				}

				// Drop the step result if the task was removed during the step. It was already rejected.
				if (this._currentTask !== task) continue;

				if (stepResult.newState === TaskState.Done) {
					if (this.verbose) {
						console.log(`- Task finished`);
					}
					// The task is done, clean up
					task.resolve(stepResult.result);
					await finalizeCurrentTask();
					// Then continue with the next iteration
					continue;
				} else if (stepResult.newState === TaskState.None) {
					continue;
				} else if (stepResult.newState === TaskState.AwaitingTask) {
					// The task spawned a sub-task. Replace it with the sub-task and continue executing
					if (this.verbose) {
						console.log(`- Task spawned a sub-task`);
					}
					const subtask = stepResult.task;
					const deadlock = this.findDeadlock(subtask);
					if (deadlock) {
						// Reject the subtask without queueing it.
						// The task receives the error at its yield once it steps again.
						const error = new Error(
							`Subtask ${getTaskName(subtask)} would wait forever. ${deadlock.join(". ")}. ${getTaskName(task)} waits for ${getTaskName(subtask)}.`,
						);
						if (this.verbose) {
							console.error(`- ${error.message}`);
						}
						subtask.reject(error as TError);
						this.endTurn(task);
						continue;
					}
					this._tasks.remove(task);
					this.assignNextTurn(task);
					// A subtask with a higher priority gets its own turn
					this.assignNextTurn(subtask);
					this._tasks.add(subtask);
					// Switching to the subtask must not count as interrupting the parent
					this._currentTask = undefined;
				} else {
					if (stepResult.newState === TaskState.AwaitingPromise) {
						// The task is waiting for something
						if (this.verbose) {
							console.log(`- Task waiting`);
						}
						// Skip the task until its promise settles, so other tasks can run in the meantime
						this.trackWaitingTask(task, stepResult.promise);
					}
					this.endTurn(task);
				}
				continue;
			}

			// No task may run right now. Wait for a new task, a settled promise or the stop signal
			this._continueSignal = createDeferredPromise();
			const nextAction = await Promise.race([
				this._continueSignal.then(() => "continue" as const),
				this._stopSignal!.then(() => "stop" as const),
			]);
			this._continueSignal = undefined;
			if (nextAction === "stop") break;
		}
		this._stopPromise!.resolve();
	}

	public async stop(): Promise<void> {
		if (!this._stopSignal) return;
		// Signal to the task runner that it should stop
		this._stopPromise = createDeferredPromise();
		this._stopSignal.resolve();
		await this._stopPromise;
	}
}
