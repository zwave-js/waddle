import type { CompareResult } from "alcalzone-shared/comparable";
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
	return `${
		task.name ?? (task.tag && JSON.stringify(task.tag)) ?? "unnamed"
	} (ID ${task.id})`;
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

/** Returns the timestamp and ID that decide where a task sorts among the tasks of the same priority */
function getQueuePosition<TaskTag extends { id: string }>(
	task: Task<unknown, TaskTag>,
): { timestamp: number; id: number } {
	// A subtask takes the queue position of the outermost parent with the same priority
	let ret = task;
	while (ret.parent && ret.parent.priority === task.priority) {
		ret = ret.parent;
	}
	return { timestamp: ret.timestamp, id: ret.id };
}

/**
 * Sorts tasks by priority, then in the order they were queued.
 * The comparison must only use properties that do not change while a task is queued.
 * Whether a task may run right now is decided when the next task gets picked.
 */
function compareTasks<TaskTag extends { id: string }>(
	a: Task<unknown, TaskTag>,
	b: Task<unknown, TaskTag>,
): CompareResult {
	if (a.priority < b.priority) return 1;
	if (a.priority > b.priority) return -1;

	const aPosition = getQueuePosition(a);
	const bPosition = getQueuePosition(b);
	if (aPosition.timestamp < bPosition.timestamp) return 1;
	if (aPosition.timestamp > bPosition.timestamp) return -1;
	if (aPosition.id !== bPosition.id) {
		return Math.sign(bPosition.id - aPosition.id) as CompareResult;
	}

	return Math.sign(b.id - a.id) as CompareResult;
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

	private _tasks = new SortedList<Task<unknown, TaskTag>>(
		undefined,
		compareTasks,
	);
	private _currentTask: Task<unknown, TaskTag> | undefined;
	/** The promises that queued tasks wait for, until they settle */
	private _waitingFor = new Map<Task<unknown, TaskTag>, Promise<unknown>>();
	/** The task in each concurrency group that has started and not finished yet */
	private _groupHolders = new Map<string, Task<unknown, TaskTag>>();

	private _idGenerator = createWrappingCounter(0xff_ff_ff);
	private _continueSignal: DeferredPromise<void> | undefined;
	private _stopSignal: DeferredPromise<void> | undefined;
	private _stopPromise: DeferredPromise<void> | undefined;

	public queueTask<T>(builder: TaskBuilder<T, TaskTag>): Promise<T> {
		const task = this.createTask(builder);
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

	/** Returns the queued or current task that is `task` itself or one of its subtasks, if any */
	private findLeafTask(
		task: Task<unknown, TaskTag>,
	): Task<unknown, TaskTag> | undefined {
		const leaves = this._currentTask
			? [this._currentTask, ...this._tasks]
			: this._tasks;
		for (const leaf of leaves) {
			for (const t of selfAndParents(leaf)) {
				if (t === task) return leaf;
			}
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
			this.releaseTask(task);
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

	/** Forgets the promise and concurrency group the scheduler tracks for a task */
	private releaseTask(task: Task<unknown, TaskTag>): void {
		this._waitingFor.delete(task);
		const groupId = task.group?.id;
		if (groupId && this._groupHolders.get(groupId) === task) {
			this._groupHolders.delete(groupId);
		}
	}

	/**
	 * Records the promise a task waits for.
	 * `pickNextTask` skips the task until the promise settles, and the run loop then wakes up.
	 */
	private trackWaitingTask(
		task: Task<unknown, TaskTag>,
		promise: Promise<unknown>,
	): void {
		if (this._waitingFor.get(task) === promise) return;
		this._waitingFor.set(task, promise);
		const settled = () => {
			// Ignore the promise if the task was reset or removed in the meantime
			if (this._waitingFor.get(task) !== promise) return;
			this._waitingFor.delete(task);
			this._continueSignal?.resolve();
		};
		promise.then(settled, settled);
	}

	/** Returns whether another task holds the concurrency group of the given task */
	private isBlockedByGroup(task: Task<unknown, TaskTag>): boolean {
		const groupId = task.group?.id;
		if (!groupId) return false;
		const holder = this._groupHolders.get(groupId);
		if (!holder) return false;
		// A group held by one of its parents counts as held by the task itself
		for (const t of selfAndParents(task)) {
			if (t === holder) return false;
		}
		return true;
	}

	/** Returns the first queued task that may take a step now */
	private pickNextTask(): Task<unknown, TaskTag> | undefined {
		let waitingPriority: TaskPriority | undefined;
		for (const task of this._tasks) {
			// While a task waits for a promise, tasks with a lower priority may not run
			if (
				waitingPriority != undefined &&
				task.priority > waitingPriority
			) {
				return;
			}
			// Skip tasks that wait for another member of their concurrency group
			if (this.isBlockedByGroup(task)) continue;
			// Skip tasks that wait for a promise
			if (this._waitingFor.has(task)) {
				waitingPriority ??= task.priority;
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
					// The scheduler puts a parent back into the queue before its subtask is cleaned up.
					// The parent must wait until it has received the subtask's result.
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
					const waitFor = evalOrStatic(value);
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
			// A task that may not be interrupted keeps running, even while it waits
			const nextTask =
				this._currentTask?.interrupt === TaskInterruptBehavior.Forbidden
					? this._currentTask
					: this.pickNextTask();
			if (nextTask) {
				// Only a task with a higher priority interrupts the current task.
				// Tasks with the same priority just run in between.
				if (
					this._currentTask &&
					this._currentTask !== nextTask &&
					this._currentTask.interrupt ===
						TaskInterruptBehavior.Restart &&
					nextTask.priority < this._currentTask.priority
				) {
					// The current task needs to be restarted after being interrupted, so reset it
					const interrupted = this._currentTask;
					this.releaseTask(interrupted);
					await interrupted.reset();
					// Re-evaluate the queue if it changed during the reset
					if (
						this._currentTask !== interrupted ||
						this.pickNextTask() !== nextTask
					) {
						continue;
					}
				}
				this._currentTask = nextTask;

				// Capture the current task, so concurrent removals can be detected after each await
				const task = nextTask;

				if (this.verbose) {
					console.log(`Stepping through task: ${getTaskName(task)}`);
				}

				const groupId = task.group?.id;
				if (groupId && !this._groupHolders.has(groupId)) {
					this._groupHolders.set(groupId, task);
				}

				const finalizeCurrentTask = async () => {
					this._tasks.remove(task);
					this.releaseTask(task);
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
				} else if (stepResult.newState === TaskState.AwaitingPromise) {
					// The task is waiting for something
					if (this.verbose) {
						console.log(`- Task waiting`);
					}

					// Skip the task until its promise settles, so other tasks can run in the meantime
					this.trackWaitingTask(task, stepResult.promise);
					if (task.interrupt !== TaskInterruptBehavior.Forbidden) {
						continue;
					}
				} else if (stepResult.newState === TaskState.AwaitingTask) {
					// The task spawned a sub-task. Replace it with the sub-task and continue executing
					if (this.verbose) {
						console.log(`- Task spawned a sub-task`);
					}
					this._tasks.add(stepResult.task);
					this._tasks.remove(task);
					// Switching to the subtask must not count as interrupting the parent
					this._currentTask = undefined;
					// Continue with the next iteration
					continue;
				} else {
					// The current task is not done, or the step result is stale after a removal.
					// Continue with the next iteration.
					continue;
				}
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
