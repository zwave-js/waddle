import { wait } from "alcalzone-shared/async";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { test } from "vitest";
import {
	type TaskBuilder,
	type TaskConcurrencyGroup,
	type TaskHandle,
	TaskInterruptBehavior,
	TaskPriority,
	type TaskReturnType,
	TaskScheduler,
} from "./Task.js";
import { noop, waitFor } from "./utils.js";

test("The scheduler can be started and stopped", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	await scheduler.stop();
});

test("An empty task runs to completion", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {},
	});
	await task;
});

test("The task promise resolves to the return value of the task function", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			return 1;
		},
	});
	t.expect(await task).toBe(1);
});

test("A task with multiple interrupt points runs to completion", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
		},
	});
	await task;
});

test("A task with multiple interrupt points has the correct result", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			return 2;
		},
	});
	t.expect(await task).toBe(2);
});

test("Multiple tasks run to completion", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			return 1;
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			return 2;
		},
	});
	const result = await Promise.all([task1, task2]);
	t.expect(result).toStrictEqual([1, 2]);
});

test("Higher priority tasks run before lower priority ones if the scheduler is started afterwards", async (t) => {
	const scheduler = new TaskScheduler();
	const order: number[] = [];

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			order.push(1);
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			order.push(2);
		},
	});
	scheduler.start();

	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual([2, 1]);
});

test("Higher priority tasks run before lower priority ones when added at the same time", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: number[] = [];

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			order.push(1);
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			order.push(2);
		},
	});

	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual([2, 1]);
});

test("Higher priority tasks run before lower priority ones when added at the same time, part 2", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: number[] = [];

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			order.push(1);
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			order.push(2);
		},
	});
	const task3 = scheduler.queueTask({
		priority: TaskPriority.Idle,
		task: async function* () {
			yield;
			yield;
			order.push(3);
		},
	});

	await Promise.all([task1, task2, task3]);
	t.expect(order).toStrictEqual([2, 1, 3]);
});

test("Higher priority tasks interrupt lower priority ones", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			await wait(1);
			yield;
			order.push("1b");
			await wait(1);
			yield;
			order.push("1c");
		},
	});
	// The test expects that task 1 has started executing before task 2 is queued
	await t1WasStarted;
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			await wait(1);
			yield;
			order.push("2b");
			await wait(1);
			yield;
			order.push("2c");
		},
	});

	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "2a", "2b", "2c", "1b", "1c"]);
});

test("Higher priority tasks interrupt lower priority ones, part 2", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			await wait(1);
			yield;
			order.push("1b");
			await wait(1);
			yield;
			order.push("1c");
		},
	});

	await t1WasStarted;

	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			await wait(1);
			yield;
			order.push("2b");
			await wait(1);
			yield;
			order.push("2c");
		},
	});

	const task3 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("3a");
			await wait(1);
			yield;
			order.push("3b");
			await wait(1);
			yield;
			order.push("3c");
		},
	});

	await Promise.all([task1, task2, task3]);

	// Tasks 2 and 3 have the same priority, so they take turns
	t.expect(order).toStrictEqual([
		"1a",
		"2a",
		"3a",
		"2b",
		"3b",
		"2c",
		"3c",
		"1b",
		"1c",
	]);
});

test("Higher priority tasks do not interrupt non-interruptible lower priority ones", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Forbidden,
		task: async function* () {
			order.push("1a");
			await wait(1);
			yield;
			order.push("1b");
			await wait(1);
			yield;
			order.push("1c");
		},
	});
	await wait(0);
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			await wait(1);
			yield;
			order.push("2b");
			await wait(1);
			yield;
			order.push("2c");
		},
	});

	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "1b", "1c", "2a", "2b", "2c"]);
});

test("Interrupting a task with the Restart interrupt behavior restarts it completely", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			await wait(1);
			yield;
			order.push("1b");
			await wait(1);
			yield;
			order.push("1c");
		},
	});
	// The test expects that task 1 has started executing before task 2 is queued
	await t1WasStarted;
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			await wait(1);
			yield;
			order.push("2b");
			await wait(1);
			yield;
			order.push("2c");
		},
	});

	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "2a", "2b", "2c", "1a", "1b", "1c"]);
});

test("Completed Restart tasks are not restarted after completion", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1IsAlmostDone = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			order.push("1a");
			yield;
			order.push("1b");
			yield;
			t1IsAlmostDone.resolve();
			order.push("1c");
		},
	});
	await t1IsAlmostDone;
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			await wait(1);
			yield;
			order.push("2b");
			await wait(1);
			yield;
			order.push("2c");
		},
	});

	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "1b", "1c", "2a", "2b", "2c"]);
});

test("Yielding a promise-returning function causes the scheduler to wait for that until resuming the task", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	// Wait long enough that the task is definitely waiting for the promise
	await wait(50);
	t.expect(order).toStrictEqual(["1a"]);

	// Run to completion
	yieldedPromise.resolve();
	await task1;

	t.expect(order).toStrictEqual(["1a", "1b"]);
});

test("While a task is waiting, higher-priority tasks are still executed", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	await wait(1);

	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should be able to finish before task 1
	await task2;

	// Task 1 should not have completed yet
	// Wait long enough that it would have if the scheduler didn't work correctly
	await wait(50);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);

	// Run task 1 to completion
	yieldedPromise.resolve();
	await task1;

	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);
});

test("Waiting tasks are deprioritized over tasks with the same priority", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	await wait(1);

	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should be able to finish before task 1
	await task2;

	// Task 1 should not have completed yet
	// Wait long enough that it would have if the scheduler didn't work correctly
	await wait(50);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);

	// Run task 1 to completion
	yieldedPromise.resolve();
	await task1;

	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);
});

test("Waiting tasks are deprioritized over tasks with a higher priority", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();
	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	// The test expects that task 1 has started executing before task 2 is queued
	await t1WasStarted;

	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should be able to finish before task 1
	await task2;

	// Task 1 should not have completed yet
	// Wait long enough that it would have if the scheduler didn't work correctly
	await wait(50);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);

	// Run task 1 to completion
	yieldedPromise.resolve();
	await task1;

	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);
});

test("Waiting tasks are NOT deprioritized over tasks with a lower priority", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	await wait(1);

	const task2 = scheduler.queueTask({
		priority: TaskPriority.Idle,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should not have started yet
	await wait(50);
	t.expect(order).toStrictEqual(["1a"]);

	// Run to completion
	yieldedPromise.resolve();
	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "1b", "2a", "2b"]);
});

test("Two tasks of the same priority can wait at the same time", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => wait(50);
			order.push("1b");
			return;
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield () => wait(100);
			order.push("2b");
			return;
		},
	});

	await Promise.all([task1, task2]);

	t.expect(order).toStrictEqual(["1a", "2a", "1b", "2b"]);
});

test("Stopping the scheduler mid-task works", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
			return;
		},
	});

	await wait(1);

	const task2 = scheduler.queueTask({
		priority: TaskPriority.Idle,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should not have started yet
	await wait(1);
	t.expect(order).toStrictEqual(["1a"]);

	await scheduler.stop();

	// "Run" to completion, but nothing should happen
	yieldedPromise.resolve();
	await wait(50);
	t.expect(order).toStrictEqual(["1a"]);
});

test("Stopping the scheduler works after multiple tasks have run to completion", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			return 1;
		},
	});
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			return 2;
		},
	});
	const result = await Promise.all([task1, task2]);
	t.expect(result).toStrictEqual([1, 2]);

	await scheduler.stop();
});

test("Tasks can yield-queue higher-priority tasks", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			order.push("inner");
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield innerBuilder;
			order.push("outer");
		},
	});

	await outer;

	t.expect(order).toStrictEqual(["inner", "outer"]);
});

test("Tasks can yield-queue same-priority tasks", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			yield;
			order.push("inner");
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield innerBuilder;
			order.push("outer");
		},
	});

	await outer;

	t.expect(order).toStrictEqual(["inner", "outer"]);
});

test("Tasks cannot yield-queue lower-priority tasks", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.Idle,
		task: async function* () {
			yield;
			yield;
			order.push("inner");
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield innerBuilder;
			order.push("outer");
		},
	});

	await t.expect(() => outer).rejects.toThrowError("lower priority");
});

test("Yielding tasks multiple levels deep works", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const yieldedPromise = createDeferredPromise<void>();

	const innerinnerBuilder: TaskBuilder<void> = {
		name: "innerinner",
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			order.push("innerinner1");
			yield () => yieldedPromise;
			order.push("innerinner2");
		},
	};

	const innerBuilder: TaskBuilder<void> = {
		name: "inner",
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			order.push("inner1");
			yield innerinnerBuilder;
			order.push("inner2");
		},
	};

	const outer = scheduler.queueTask({
		name: "outer",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("outer1");
			yield innerBuilder;
			order.push("outer2");
		},
	});

	// Wait long enough that the task is definitely waiting for the promise
	await wait(10);
	t.expect(order).toStrictEqual(["outer1", "inner1", "innerinner1"]);

	// Run to completion
	yieldedPromise.resolve();
	await outer;

	t.expect(order).toStrictEqual([
		"outer1",
		"inner1",
		"innerinner1",
		"innerinner2",
		"inner2",
		"outer2",
	]);
});

test("Tasks receive the result of yielded tasks", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const innerBuilder: TaskBuilder<string> = {
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			return "foo";
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			const result = (yield innerBuilder) as TaskReturnType<
				typeof innerBuilder
			>;
			return result;
		},
	});

	t.expect(await outer).toBe("foo");
});

test("Tasks receive the result of yielded tasks, part 2", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const inner1Builder: TaskBuilder<string> = {
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			return "foo";
		},
	};

	const inner3Builder: TaskBuilder<string> = {
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			yield;
			return "bar";
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			const result1 = (yield inner1Builder) as TaskReturnType<
				typeof inner1Builder
			>;
			const result2 = (yield) as any;
			const result3 = (yield inner3Builder) as TaskReturnType<
				typeof inner3Builder
			>;
			return result1 + (result2 ?? "") + result3;
		},
	});

	t.expect(await outer).toBe("foobar");
});

test("Tasks receive the result of yielded tasks, part 3", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const innerBuilder: TaskBuilder<unknown> = {
		priority: TaskPriority.High,
		task: async function* () {
			yield;
			throw new Error("foo");
		},
	};

	const outerBuilder: TaskBuilder<unknown> = {
		priority: TaskPriority.Normal,
		task: async function* () {
			try {
				yield innerBuilder;
				throw new Error("This should not happen");
			} catch (e) {
				return e as Error;
			}
		},
	};

	const outer = scheduler.queueTask(outerBuilder);

	const result = await outer;
	t.expect(result instanceof Error).toBe(true);
	t.expect((result as Error).message).toBe("foo");
});

test("Tasks can queue lower-priority tasks without waiting for them", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	let inner: Promise<void>;

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.Idle,
		task: async function* () {
			yield;
			order.push("inner");
		},
	};

	const outer = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			inner = scheduler.queueTask(innerBuilder);
			yield;
			order.push("outer");
		},
	});

	await outer;
	await inner!;

	t.expect(order).toStrictEqual(["outer", "inner"]);
});

test("Failing tasks reject the corresponding Promise", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			throw new Error("Task 1 failed");
		},
	});

	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield;
			return 2;
		},
	});

	await t.expect(() => task1).rejects.toThrowError("Task 1 failed");
	t.expect(await task2).toBe(2);
});

test("Tasks can be removed if they haven't been started yet", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const longRunningThing = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			await longRunningThing;
			yield;
			order.push("1b");
			return;
		},
	});

	await wait(1);

	const task2 = scheduler.queueTask({
		name: "task2",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
			return;
		},
	});

	// Task 2 should not have started yet
	await wait(1);
	t.expect(order).toStrictEqual(["1a"]);

	await scheduler.removeTasks((t) => t.name === "task2");

	await t.expect(() => task2).rejects.toThrowError("Task was removed");

	// await assertZWaveError(t.expect, () => task2, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });

	// Run to completion
	longRunningThing.resolve();
	await task1;
	t.expect(order).toStrictEqual(["1a", "1b"]);
});

test("Tasks can be removed while paused", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			yield () => wait(10);
			order.push("1b");
			return;
		},
		cleanup() {
			order.push("1c");
			return Promise.resolve();
		},
	});

	await t1WasStarted;
	// The task should have run to the first yield
	t.expect(order).toStrictEqual(["1a"]);

	await scheduler.removeTasks((t) => true);

	await t.expect(() => task1).rejects.toThrowError("Task was removed");

	// await assertZWaveError(t.expect, () => task1, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });

	t.expect(order).toStrictEqual(["1a", "1c"]);
});

test("Tasks can be removed while paused, part 2", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => wait(10);
			order.push("1b");
			return;
		},
		cleanup() {
			order.push("1c");
			return Promise.resolve();
		},
	});

	const task2 = scheduler.queueTask({
		name: "task2",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield () => wait(10);
			order.push("2b");
			return;
		},
		cleanup() {
			order.push("2c");
			return Promise.resolve();
		},
	});

	await wait(5);
	// The tasks have run to the first yield
	t.expect(order).toStrictEqual(["1a", "2a"]);

	await scheduler.removeTasks((t) => true);

	await t.expect(() => task1).rejects.toThrowError("Task was removed");
	await t.expect(() => task2).rejects.toThrowError("Task was removed");

	// await assertZWaveError(t.expect, () => task1, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });
	// await assertZWaveError(t.expect, () => task2, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });

	// Task "2" took the last step, so it is the current task and gets cleaned up last
	t.expect(order).toStrictEqual(["1a", "2a", "1c", "2c"]);
});

test("Tasks can be removed while running", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			await wait(10);
			yield;
			order.push("1b");
		},
		cleanup() {
			order.push("1c");
			return Promise.resolve();
		},
	});

	const task2 = scheduler.queueTask({
		name: "task2",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
		cleanup() {
			order.push("2c");
			return Promise.resolve();
		},
	});

	await t1WasStarted;
	// Task 1 should have run to the first yield,
	// Task 2 should not have started yet
	t.expect(order).toStrictEqual(["1a"]);

	await scheduler.removeTasks((t) => true);

	await t.expect(() => task1).rejects.toThrowError("Task was removed");
	await t.expect(() => task2).rejects.toThrowError("Task was removed");

	// await assertZWaveError(t.expect, () => task1, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });
	// await assertZWaveError(t.expect, () => task2, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });

	// Only task 1 should have been cleaned up, since task 2 was not started
	t.expect(order).toStrictEqual(["1a", "1c"]);
});

test("Tasks can be removed while running and paused", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();
	const t2WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			yield () => wait(10);
			order.push("1b");
		},
		cleanup() {
			order.push("1c");
			return Promise.resolve();
		},
	});

	const task2 = scheduler.queueTask({
		name: "task2",
		priority: TaskPriority.Normal,
		task: async function* () {
			t2WasStarted.resolve();
			order.push("2a");
			await wait(10);
			yield;
			order.push("2b");
		},
		cleanup() {
			order.push("2c");
			return Promise.resolve();
		},
	});

	await Promise.all([t1WasStarted, t2WasStarted]);
	// Both tasks should have run to the first yield.
	t.expect(order).toStrictEqual(["1a", "2a"]);

	await scheduler.removeTasks((t) => true);

	await t.expect(() => task1).rejects.toThrowError("Task was removed");
	await t.expect(() => task2).rejects.toThrowError("Task was removed");

	// await assertZWaveError(t.expect, () => task1, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });
	// await assertZWaveError(t.expect, () => task2, {
	// 	errorCode: ZWaveErrorCodes.Driver_TaskRemoved,
	// });

	// Both tasks should be cleaned up, 1c before 2c,
	// since task 2 was the current task and should be cleaned up last
	t.expect(order).toStrictEqual(["1a", "2a", "1c", "2c"]);
});

test("The task rejection uses the given error, if any", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			t1WasStarted.resolve();
			order.push("1a");
			yield () => wait(10);
			order.push("1b");
			return;
		},
		cleanup() {
			order.push("1c");
			return Promise.resolve();
		},
	});

	// task 1 has run to the first yield
	await t1WasStarted;
	t.expect(order).toStrictEqual(["1a"]);

	await scheduler.removeTasks(
		(t) => true,
		new Error("Test error" /*, ZWaveErrorCodes.Driver_Reset */),
	);

	await t.expect(() => task1).rejects.toThrowError("Test error");

	// await assertZWaveError(t.expect, () => task1, {
	// 	errorCode: ZWaveErrorCodes.Driver_Reset,
	// });

	t.expect(order).toStrictEqual(["1a", "1c"]);
});

test("Canceling nested tasks works", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const yieldedPromise = createDeferredPromise<void>();

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
			yield () => yieldedPromise;
			order.push("2b");
		},
	};

	const outer = scheduler
		.queueTask({
			priority: TaskPriority.Normal,
			task: async function* () {
				order.push("1a");
				yield innerBuilder;
				order.push("1b");
			},
		})
		.catch(noop);

	// Wait long enough that the task is definitely waiting for the promise
	await wait(50);
	t.expect(order).toStrictEqual(["1a", "2a"]);

	// Cancel all tasks
	await scheduler.removeTasks(() => true);

	t.expect(order).toStrictEqual(["1a", "2a"]);
});

test("Canceling nested tasks works, part 2", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const yieldedPromise = createDeferredPromise<void>();

	const innerBuilder: TaskBuilder<void> = {
		priority: TaskPriority.High,
		name: "inner",
		task: async function* () {
			yield () => yieldedPromise;
		},
	};

	const outerBuilder: TaskBuilder<unknown> = {
		priority: TaskPriority.Normal,
		task: async function* () {
			try {
				yield innerBuilder;
			} catch (e) {
				return "canceled";
			}
		},
	};

	const outer = scheduler.queueTask(outerBuilder);

	// Wait long enough that the task is definitely waiting for the promise
	await wait(10);

	// Cancel all tasks
	// FIXME: Restore parent tasks when removing nested tasks
	await scheduler.removeTasks((t) => t.name === "inner");

	t.expect(await outer).toBe("canceled");
});

test("Splitting tasks into multiple generator functions works", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");

			async function* inner() {
				order.push("1b");
				yield;
				order.push("1c");
			}

			yield* inner();
			yield;
			order.push("1d");
		},
	});

	await task1;

	t.expect(order).toStrictEqual(["1a", "1b", "1c", "1d"]);
});

test("Split tasks can be canceled", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler
		.queueTask({
			priority: TaskPriority.Normal,
			task: async function* () {
				order.push("1a");

				async function* inner() {
					order.push("1b");
					yield () => yieldedPromise;
					order.push("1c");
				}

				yield* inner();
				yield;
				order.push("1d");
			},
		})
		.catch(noop);

	// Wait long enough that the task is definitely waiting for the promise
	await wait(10);

	// Cancel all tasks
	await scheduler.removeTasks(() => true);

	t.expect(order).toStrictEqual(["1a", "1b"]);
});

test("Tasks in the same concurrency group prioritize active/waiting tasks over pending tasks", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	const yieldedPromise = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
		},
	});

	// Wait a bit to ensure the first task starts and becomes waiting
	await wait(10);

	// Now add another task with the same priority and concurrency group
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
	});

	// Resolve the waiting task
	yieldedPromise.resolve();

	// Wait for both tasks to complete
	await Promise.all([task1, task2]);

	// The tasks are in the same concurrency group, so task 1 should complete first before task 2 can start
	t.expect(order).toStrictEqual(["1a", "1b", "2a", "2b"]);

	await scheduler.stop();
});

test("Tasks in different concurrency groups do not block each other while waiting", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group1: TaskConcurrencyGroup = { id: "group-1" };
	const group2: TaskConcurrencyGroup = { id: "group-2" };

	const yieldedPromise = createDeferredPromise<void>();
	const waitingTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group: group1,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
		},
	});

	// Wait a bit to ensure the first task starts and becomes waiting
	await wait(10);

	// Add another task with the same priority but a different concurrency group
	const pendingTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group: group2,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
	});

	// Resolve the waiting task
	yieldedPromise.resolve();

	await Promise.all([waitingTask, pendingTask]);

	// The tasks are in different concurrency groups, so they are expected to be interleaved
	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);

	await scheduler.stop();
});

test("Tasks without concurrency groups do not block each other while waiting", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Create a task that will become waiting (no group)
	const yieldedPromise = createDeferredPromise<void>();
	const waitingTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
		},
	});

	// Wait a bit to ensure the first task starts and becomes waiting
	await wait(10);

	// Add another task (also no group)
	const pendingTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
	});

	// Resolve the waiting task
	yieldedPromise.resolve();

	await Promise.all([waitingTask, pendingTask]);

	// Task 2 does not wait for any promise, so it should finish before task 1 resumes
	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);

	await scheduler.stop();
});

test("Concurrency groups take precedence over priority", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	// Create a low priority task that will become waiting
	const yieldedPromise = createDeferredPromise<void>();
	const waitingTask = scheduler.queueTask({
		priority: TaskPriority.Low,
		group,
		task: async function* () {
			order.push("1a");
			yield () => yieldedPromise;
			order.push("1b");
		},
	});

	// Wait a bit to ensure the first task starts and becomes waiting
	await wait(10);

	// Add a higher priority pending task in the same group
	const highPriorityTask = scheduler.queueTask({
		priority: TaskPriority.High,
		group,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
	});

	// Resolve the waiting task
	yieldedPromise.resolve();

	await Promise.all([waitingTask, highPriorityTask]);

	// Because the concurrency group is the same, the higher priority task has to wait, even though
	// it has a higher priority than the waiting task
	t.expect(order).toStrictEqual(["1a", "1b", "2a", "2b"]);

	await scheduler.stop();
});

test("Yielding without waiting works normally, even when concurrency groups are involved", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	// Create a task that will yield and continue (active state)
	const activeTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("1a");
			yield; // This keeps it active, not waiting
			order.push("1b");
			yield;
			order.push("1c");
		},
	});

	// Wait a bit to let the active task start
	await wait(10);

	// Add a pending task in the same group
	const pendingTask = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("2a");
			yield;
			order.push("2b");
		},
	});

	await Promise.all([activeTask, pendingTask]);

	// The active task should complete before the pending task
	t.expect(order).toStrictEqual(["1a", "1b", "1c", "2a", "2b"]);

	await scheduler.stop();
});

test("A group member spawned as a subtask waits for the active member of its group", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	// Each parent has no group and spawns a grouped subtask that waits after each step
	const queueParent = (id: number) =>
		scheduler.queueTask({
			priority: TaskPriority.Normal,
			task: async function* () {
				yield {
					priority: TaskPriority.Normal,
					group,
					task: async function* () {
						for (const step of ["a", "b", "c"]) {
							order.push(`${id}${step}`);
							yield () => wait(5);
						}
					},
				};
			},
		});

	// The second subtask is spawned while the first one waits, but must not start before the first one is done
	await Promise.all([queueParent(1), queueParent(2)]);
	t.expect(order).toStrictEqual(["1a", "1b", "1c", "2a", "2b", "2c"]);

	await scheduler.stop();
});

test("A group member waits for the active member of its group while a task of another group waits ahead of both", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	// Task 1 has no group and waits at the head of the queue for the whole test
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			yield () => gate1;
		},
	});
	await wait(1);

	// Task 2 starts and holds the group while it waits
	const gate2 = createDeferredPromise<void>();
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("2a");
			yield () => gate2;
			order.push("2b");
		},
	});
	await wait(1);

	// Task 3 is in the same group, so it must not start while task 2 waits
	const task3 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("3a");
		},
	});
	await wait(10);
	t.expect(order).toStrictEqual(["2a"]);

	// Task 3 starts once task 2 is done, while task 1 still waits
	gate2.resolve();
	await Promise.all([task2, task3]);
	t.expect(order).toStrictEqual(["2a", "2b", "3a"]);

	gate1.resolve();
	await task1;

	await scheduler.stop();
});

test("A group member that waits for a subtask keeps other members of its group from starting", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "test-group" };

	// Task 1 holds the group and waits for a subtask without a group
	const gate2 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("1a");
			yield {
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
					yield () => gate2;
				},
			};
			order.push("1b");
		},
	});
	await wait(1);

	// Task 3 is in the same group, so it must not start while task 1 waits for its subtask
	const task3 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("3a");
		},
	});
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a"]);

	// Task 3 starts once task 1 is done
	gate2.resolve();
	await Promise.all([task1, task3]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "3a"]);

	await scheduler.stop();
});

test("A subtask in the same concurrency group as its parent can run", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const group: TaskConcurrencyGroup = { id: "test-group" };

	const result = await scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			return (yield {
				priority: TaskPriority.High,
				group,
				task: async function* () {
					yield () => wait(1);
					return "ok";
				},
			}) as string;
		},
	});
	t.expect(result).toBe("ok");

	await scheduler.stop();
});

test("A task resumes when its promise settles, even while another task waits ahead of it", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 waits at the head of the queue
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 waits behind task 1
	const gate2 = createDeferredPromise<void>();
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield () => gate2;
			order.push("2b");
		},
	});
	await wait(1);

	// Task 2 continues as soon as its promise settles, while task 1 still waits
	gate2.resolve();
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);

	gate1.resolve();
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a", "2b", "1b"]);

	await scheduler.stop();
});

test("A subtask takes turns in place of a parent with the same priority", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 takes a step, then spawns subtask 2 with the same priority, then takes another step
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield {
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
					yield;
					order.push("2b");
				},
			};
			order.push("1b");
		},
	});

	const task3 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("3a");
			yield;
			order.push("3b");
			yield;
			order.push("3c");
		},
	});

	// Spawning subtask 2 ends the turn of task 1.
	// Task 1 continues in the turn subtask 2 finished in.
	await Promise.all([task1, task3]);
	t.expect(order).toStrictEqual(["1a", "3a", "2a", "3b", "2b", "1b", "3c"]);

	await scheduler.stop();
});

test("A subtask with a higher priority than its parent runs after tasks of its priority that were queued before it", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 queues task 2 with a high priority, then spawns subtask 3 with the same high priority
	let task2: Promise<void> | undefined;
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			task2 = scheduler.queueTask({
				priority: TaskPriority.High,
				task: async function* () {
					order.push("2a");
				},
			});
			yield {
				priority: TaskPriority.High,
				task: async function* () {
					order.push("3a");
				},
			};
		},
	});

	// The queue position of task 1 does not count among the high-priority tasks
	await task1;
	await task2;
	t.expect(order).toStrictEqual(["2a", "3a"]);

	await scheduler.stop();
});

test("A started Restart task keeps its priority to itself while it waits", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 must be restarted after an interruption and waits for a promise
	const gate1 = createDeferredPromise<void>();
	let starts = 0;
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			order.push(`1a${++starts}`);
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 has the same priority, so it must not run while task 1 waits
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
		},
	});
	await wait(10);
	t.expect(order).toStrictEqual(["1a1"]);

	gate1.resolve();
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a1", "1b", "2a"]);

	await scheduler.stop();
});

test("A started Restart task keeps running ahead of an older task with the same priority whose promise settled", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 waits for a promise
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 starts while task 1 waits and settles task 1's promise during its first step
	let starts = 0;
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			order.push(`2a${++starts}`);
			gate1.resolve();
			await wait(1);
			yield;
			order.push("2b");
			yield;
			order.push("2c");
		},
	});

	// Task 1 has the next turn, but task 2 keeps running without a restart until it is done
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a1", "2b", "2c", "1b"]);

	await scheduler.stop();
});

test("Two Restart tasks with the same priority that both wait do not restart each other", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const starts = [0, 0];
	const createTask = (n: number) =>
		scheduler.queueTask({
			priority: TaskPriority.Normal,
			interrupt: TaskInterruptBehavior.Restart,
			task: async function* () {
				order.push(`${n}a${++starts[n - 1]}`);
				yield () => wait(5);
				order.push(`${n}b`);
			},
		});

	await Promise.all([createTask(1), createTask(2)]);
	t.expect(order).toStrictEqual(["1a1", "1b", "2a1", "2b"]);

	await scheduler.stop();
});

test("A higher-priority task restarts a started Restart task", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 must be restarted after an interruption and waits for a new promise each time it starts
	const gates = [
		createDeferredPromise<void>(),
		createDeferredPromise<void>(),
	];
	let starts = 0;
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			const run = ++starts;
			order.push(`1a${run}`);
			yield () => gates[run - 1];
			order.push(`1b${run}`);
		},
	});
	await wait(1);

	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("2a");
		},
	});
	await task2;

	// Task 1 starts over and waits for its second promise
	await wait(1);
	t.expect(order).toStrictEqual(["1a1", "2a", "1a2"]);

	gates[1].resolve();
	await task1;
	t.expect(order).toStrictEqual(["1a1", "2a", "1a2", "1b2"]);

	await scheduler.stop();
});

test("A started Restart task lets the holder of a concurrency group run when its subtask waits for that group", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "group" };

	// Task 1 holds the group and waits
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 keeps the priority to itself, then spawns a subtask in the group of task 1
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			order.push("2a");
			yield {
				priority: TaskPriority.Normal,
				group,
				task: async function* () {
					order.push("3a");
				},
			};
			order.push("2b");
		},
	});
	await wait(1);

	// Task 1 may finish, because the subtask of task 2 waits for it
	gate1.resolve();
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "3a", "2b"]);

	await scheduler.stop();
});

test("A group member with a lower priority runs in place of a blocked member with a higher priority, while a task with a priority in between waits", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "group" };

	// Task 1 has a low priority, holds the group and waits
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Low,
		group,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 waits for task 3, which has a high priority and is in the group of task 1
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			yield () =>
				scheduler.queueTask({
					priority: TaskPriority.High,
					group,
					task: async function* () {
						order.push("3a");
					},
				});
			order.push("2b");
		},
	});
	await wait(1);
	t.expect(order).toStrictEqual(["1a", "2a"]);

	// Task 2 waits, but task 1 still runs in place of task 3
	gate1.resolve();
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "3a", "2b"]);

	await scheduler.stop();
});

test("A waiting Restart task that holds a group finishes before a member of its group and a task without a group", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "group" };

	// Task 1 must be restarted after an interruption, holds the group and waits
	const gate1 = createDeferredPromise<void>();
	let starts = 0;
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			order.push(`1a${++starts}`);
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	const createTask = (n: number, group?: TaskConcurrencyGroup) =>
		scheduler.queueTask({
			priority: TaskPriority.Normal,
			group,
			task: async function* () {
				order.push(`${n}a`);
			},
		});
	const task2 = createTask(2, group);
	const task3 = createTask(3);

	// Neither task 2 nor task 3 runs while task 1 waits, so task 1 is not restarted
	await wait(10);
	t.expect(order).toStrictEqual(["1a1"]);

	gate1.resolve();
	await Promise.all([task1, task2, task3]);
	t.expect(order).toStrictEqual(["1a1", "1b", "2a", "3a"]);

	await scheduler.stop();
});

test("A Forbidden task keeps other tasks from running while its subtask runs", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 may not be interrupted and spawns subtask 2
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Forbidden,
		task: async function* () {
			order.push("1a");
			yield {
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
					// Task 3 has the same priority and task 4 has a higher one
					task3 = createTask(3, TaskPriority.Normal);
					task4 = createTask(4, TaskPriority.High);
					yield;
					order.push("2b");
				},
			};
			order.push("1b");
		},
	});

	const createTask = (n: number, priority: TaskPriority) =>
		scheduler.queueTask({
			priority,
			task: async function* () {
				order.push(`${n}a`);
				yield;
				order.push(`${n}b`);
			},
		});
	let task3: Promise<void> | undefined;
	let task4: Promise<void> | undefined;

	// Tasks 3 and 4 only run after task 1 is done
	await task1;
	await Promise.all([task3, task4]);
	t.expect(order).toStrictEqual([
		"1a",
		"2a",
		"2b",
		"1b",
		"4a",
		"4b",
		"3a",
		"3b",
	]);

	await scheduler.stop();
});

test("A Forbidden task lets the holder of a concurrency group run when its subtask waits for that group", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "group" };

	// Task 1 holds the group and waits
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		group,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 may not be interrupted and spawns a subtask in the group of task 1
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Forbidden,
		task: async function* () {
			order.push("2a");
			yield {
				priority: TaskPriority.Normal,
				group,
				task: async function* () {
					order.push("3a");
				},
			};
			order.push("2b");
		},
	});
	await wait(1);

	// Task 1 may finish, because the subtask of task 2 waits for it
	gate1.resolve();
	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "3a", "2b"]);

	await scheduler.stop();
});

test("Tasks with the same priority take turns at each yield", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	const createTask = (n: number) =>
		scheduler.queueTask({
			priority: TaskPriority.Normal,
			task: async function* () {
				order.push(`${n}a`);
				yield;
				order.push(`${n}b`);
				yield;
				order.push(`${n}c`);
			},
		});

	await Promise.all([createTask(1), createTask(2)]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "2b", "1c", "2c"]);

	await scheduler.stop();
});

test("Tasks in the same concurrency group do not take turns with each other", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];
	const group: TaskConcurrencyGroup = { id: "group" };

	const createTask = (n: number, group?: TaskConcurrencyGroup) =>
		scheduler.queueTask({
			priority: TaskPriority.Normal,
			group,
			task: async function* () {
				order.push(`${n}a`);
				yield;
				order.push(`${n}b`);
			},
		});

	// Task 3 is not in the group, so it takes turns with the group members
	await Promise.all([
		createTask(1, group),
		createTask(2, group),
		createTask(3),
	]);
	t.expect(order).toStrictEqual(["1a", "3a", "1b", "2a", "3b", "2b"]);

	await scheduler.stop();
});

test("A task resumes at the next yield of the current task once its promise settles", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const order: string[] = [];

	// Task 1 waits for a promise
	const gate1 = createDeferredPromise<void>();
	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield () => gate1;
			order.push("1b");
		},
	});
	await wait(1);

	// Task 2 settles the promise of task 1 during its first step
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			gate1.resolve();
			await wait(1);
			yield;
			order.push("2b");
			yield;
			order.push("2c");
		},
	});

	await Promise.all([task1, task2]);
	t.expect(order).toStrictEqual(["1a", "2a", "1b", "2b", "2c"]);

	await scheduler.stop();
});

test("The type-safe wrapper works correctly", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const inner = {
		priority: TaskPriority.Normal,
		task: async function* () {
			return 42;
		},
	};

	const task = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			const foo: string = yield* waitFor(Promise.resolve("bar"));
			const baz = yield* waitFor(inner);
			return [foo, baz] as const;
		},
	});

	const result = await task;
	t.expect(result).toStrictEqual(["bar", 42]);

	await scheduler.stop();
});

test("The current task can remove itself synchronously mid-step", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	let removeResult: Promise<boolean> | undefined;

	const task1 = scheduler.queueTask({
		name: "task1",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			await wait(1);
			// Simulates an event handler that removes the current task
			// while its step is still in flight
			removeResult = scheduler.removeTasks((t) => t.name === "task1");
			order.push("1b");
		},
		cleanup: async () => {
			order.push("1c");
			await wait(1);
		},
	});

	await t.expect(() => task1).rejects.toThrowError("Task was removed");
	t.expect(await removeResult!).toBe(true);

	// The cleanup runs during the removeTasks call, before the generator resumes
	t.expect(order).toStrictEqual(["1a", "1c", "1b"]);

	// The scheduler must still be able to execute new tasks
	const task2 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			return 2;
		},
	});
	t.expect(await task2).toBe(2);

	await scheduler.stop();
});

test("The current task can be removed while it is waiting for a promise", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();
	const t1CleanupStarted = createDeferredPromise<void>();
	const t1CleanupGate = createDeferredPromise<void>();
	const yieldedPromise = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		name: "task1",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			t1WasStarted.resolve();
			yield () => yieldedPromise;
			order.push("1b");
		},
		cleanup: async () => {
			order.push("1c");
			t1CleanupStarted.resolve();
			await t1CleanupGate;
		},
	});

	await t1WasStarted;

	// Remove the waiting task. Its cleanup is gated, so the removal
	// is still in progress while the scheduler continues running.
	const removeResult = scheduler.removeTasks((t) => t.name === "task1");
	await t1CleanupStarted;

	// Queue another task while the removal is in progress
	const t2WasStarted = createDeferredPromise<void>();
	const t2Gate = createDeferredPromise<void>();
	const task2 = scheduler.queueTask({
		name: "task2",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
			t2WasStarted.resolve();
			await t2Gate;
			return "ok";
		},
	});

	await t2WasStarted;

	// Finish the removal while task 2's step is in flight
	t1CleanupGate.resolve();
	t.expect(await removeResult).toBe(true);
	await t.expect(() => task1).rejects.toThrowError("Task was removed");

	// Task 2 must not be affected by the removal of task 1
	t2Gate.resolve();
	t.expect(await task2).toBe("ok");

	t.expect(order).toStrictEqual(["1a", "1c", "2a"]);

	await scheduler.stop();
});

test("A task can remove all other tasks by comparing them to its own handle", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();
	const removeGate = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		tag: { id: "restart" },
		priority: TaskPriority.Normal,
		task: async function* (thisTask) {
			order.push("1a");
			t1WasStarted.resolve();
			yield () =>
				removeGate.then(() =>
					scheduler.removeTasks((t) => t !== thisTask),
				);
			order.push("1b");
			return "ok";
		},
	});

	await t1WasStarted;

	// A second task with the same tag must be removed, even though the predicate cannot tell them apart by tag
	const task2 = scheduler.queueTask({
		tag: { id: "restart" },
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("2a");
		},
	});

	removeGate.resolve();

	t.expect(await task1).toBe("ok");
	await t.expect(() => task2).rejects.toThrowError("Task was removed");
	t.expect(order).toStrictEqual(["1a", "1b"]);

	await scheduler.stop();
});

test("A restarted task receives the same handle again", async (t) => {
	const scheduler = new TaskScheduler();
	const handles: TaskHandle[] = [];
	scheduler.start();

	const t1WasStarted = createDeferredPromise<void>();

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* (thisTask) {
			handles.push(thisTask);
			t1WasStarted.resolve();
			await wait(1);
			yield;
		},
	});

	await t1WasStarted;
	const task2 = scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {},
	});

	await Promise.all([task1, task2]);

	t.expect(handles).toHaveLength(2);
	t.expect(handles[0]).toBe(handles[1]);

	await scheduler.stop();
});

test("A subtask's handle references the parent task's handle", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	let parentHandle: TaskHandle | undefined;
	let childHandle: TaskHandle | undefined;

	await scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* (thisTask) {
			parentHandle = thisTask;
			yield {
				priority: TaskPriority.Normal,
				task: async function* (thisTask) {
					childHandle = thisTask;
				},
			};
		},
	});

	t.expect(childHandle).toBeDefined();
	t.expect(childHandle).not.toBe(parentHandle);
	t.expect(childHandle!.parent).toBe(parentHandle);

	await scheduler.stop();
});

test("Removing a parent and its subtask rejects both and does not resume the parent", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const childStarted = createDeferredPromise<void>();
	const childGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			try {
				yield {
					name: "child",
					priority: TaskPriority.Normal,
					task: async function* () {
						order.push("2a");
						childStarted.resolve();
						yield () => childGate;
						order.push("2b");
					},
					cleanup: async () => {
						order.push("2c");
					},
				};
			} catch {
				order.push("1b");
			}
			order.push("1c");
		},
		cleanup: async () => {
			order.push("1d");
		},
	});

	await childStarted;
	await wait(1);

	t.expect(await scheduler.removeTasks(() => true)).toBe(true);
	await t.expect(() => parent).rejects.toThrowError("Task was removed");
	t.expect(scheduler.findTask(() => true)).toBeUndefined();

	childGate.resolve();
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a", "2c", "1d"]);

	await scheduler.stop();
});

test("Removing a waiting parent also removes the subtask it waits for", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const childStarted = createDeferredPromise<void>();
	const childGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
					childStarted.resolve();
					yield () => childGate;
					order.push("2b");
				},
				cleanup: async () => {
					order.push("2c");
				},
			};
			order.push("1b");
		},
		cleanup: async () => {
			order.push("1c");
		},
	});

	await childStarted;
	await wait(1);
	const child = scheduler.findTask((t) => t.name === "child");
	t.expect(child).toBeDefined();

	t.expect(await scheduler.removeTasks((t) => t.name === "parent")).toBe(
		true,
	);
	await t.expect(() => parent).rejects.toThrowError("Task was removed");
	await t.expect(() => child!).rejects.toThrowError("Task was removed");
	t.expect(scheduler.findTask(() => true)).toBeUndefined();

	childGate.resolve();
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a", "2c", "1c"]);

	await scheduler.stop();
});

test("Removing a nested parent restores the outer task, which may continue", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const innerStarted = createDeferredPromise<void>();
	const innerGate = createDeferredPromise<void>();
	let innerError: unknown;

	const outer = scheduler.queueTask({
		name: "outer",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			try {
				yield {
					name: "middle",
					priority: TaskPriority.Normal,
					task: async function* () {
						order.push("2a");
						try {
							yield {
								name: "inner",
								priority: TaskPriority.Normal,
								task: async function* () {
									order.push("3a");
									innerStarted.resolve();
									yield () => innerGate;
									order.push("3b");
								},
								cleanup: async () => {
									order.push("3c");
								},
							};
						} catch {
							order.push("2b");
						}
						order.push("2c");
					},
					cleanup: async () => {
						order.push("2d");
					},
				};
			} catch (e) {
				innerError = e;
				order.push("1b");
			}
			order.push("1c");
			return "ok";
		},
		cleanup: async () => {
			order.push("1d");
		},
	});

	await innerStarted;
	await wait(1);

	t.expect(
		await scheduler.removeTasks(
			(t) => t.name === "middle" || t.name === "inner",
		),
	).toBe(true);

	t.expect(await outer).toBe("ok");
	t.expect((innerError as Error).message).toBe("Task was removed");

	innerGate.resolve();
	await wait(10);
	t.expect(order).toStrictEqual([
		"1a",
		"2a",
		"3a",
		"3c",
		"2d",
		"1b",
		"1c",
		"1d",
	]);

	await scheduler.stop();
});

test("findTask finds a parent task while it waits for a subtask", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const childStarted = createDeferredPromise<void>();
	const childGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					childStarted.resolve();
					yield () => childGate;
				},
			};
			return "ok";
		},
	});

	await childStarted;
	await wait(1);
	t.expect(scheduler.findTask((t) => t.name === "parent")).toBe(parent);
	t.expect(scheduler.findTask((t) => t.name === "child")).toBeDefined();

	childGate.resolve();
	t.expect(await parent).toBe("ok");
	t.expect(scheduler.findTask(() => true)).toBeUndefined();

	await scheduler.stop();
});

test("A parent can be found from a continuation of its finished subtask's promise", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const childStarted = createDeferredPromise<void>();
	const childGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					childStarted.resolve();
					yield () => childGate;
				},
			};
			return "ok";
		},
	});

	await childStarted;
	await wait(1);
	const child = scheduler.findTask((t) => t.name === "child")!;
	const parentFound = child.then(
		() => !!scheduler.findTask((t) => t.name === "parent"),
	);

	childGate.resolve();
	t.expect(await parentFound).toBe(true);
	t.expect(await parent).toBe("ok");

	await scheduler.stop();
});

test("A parent can be found while its finished subtask cleans up, and resumes afterwards", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const cleanupStarted = createDeferredPromise<void>();
	const cleanupGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
				},
				cleanup: async () => {
					order.push("2b");
					cleanupStarted.resolve();
					await cleanupGate;
					order.push("2c");
				},
			};
			order.push("1b");
			return "ok";
		},
	});

	await cleanupStarted;
	t.expect(scheduler.findTask((t) => t.name === "parent")).toBe(parent);

	cleanupGate.resolve();
	t.expect(await parent).toBe("ok");
	t.expect(order).toStrictEqual(["1a", "2a", "2b", "2c", "1b"]);

	await scheduler.stop();
});

test("A parent can be removed while its finished subtask cleans up", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const cleanupStarted = createDeferredPromise<void>();
	const cleanupGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					order.push("2a");
				},
				cleanup: async () => {
					order.push("2b");
					cleanupStarted.resolve();
					await cleanupGate;
				},
			};
			order.push("1b");
		},
	});

	await cleanupStarted;
	t.expect(await scheduler.removeTasks((t) => t.name === "parent")).toBe(
		true,
	);
	await t.expect(() => parent).rejects.toThrowError("Task was removed");

	cleanupGate.resolve();
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);
	t.expect(scheduler.findTask(() => true)).toBeUndefined();

	await scheduler.stop();
});

test("A parent can be found while its removed subtask cleans up, and handles the error afterwards", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const childStarted = createDeferredPromise<void>();
	const childGate = createDeferredPromise<void>();
	const cleanupStarted = createDeferredPromise<void>();
	const cleanupGate = createDeferredPromise<void>();

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			try {
				yield {
					name: "child",
					priority: TaskPriority.Normal,
					task: async function* () {
						order.push("2a");
						childStarted.resolve();
						yield () => childGate;
					},
					cleanup: async () => {
						order.push("2b");
						cleanupStarted.resolve();
						await cleanupGate;
						order.push("2c");
					},
				};
			} catch {
				order.push("1b");
			}
			return "recovered";
		},
	});

	await childStarted;
	await wait(1);
	const removed = scheduler.removeTasks((t) => t.name === "child");
	await cleanupStarted;
	t.expect(scheduler.findTask((t) => t.name === "parent")).toBe(parent);

	// Wake up the scheduler, so it picks the parent before the cleanup is done
	const other = scheduler.queueTask({
		priority: TaskPriority.Low,
		task: async function* () {
			order.push("3a");
		},
	});
	await wait(10);
	t.expect(order).toStrictEqual(["1a", "2a", "2b"]);

	cleanupGate.resolve();
	t.expect(await removed).toBe(true);
	t.expect(await parent).toBe("recovered");
	await other;
	t.expect(order).toStrictEqual(["1a", "2a", "2b", "2c", "1b", "3a"]);

	await scheduler.stop();
});

test("A parent with the Restart interrupt behavior is not restarted when it yields a subtask", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	let starts = 0;
	const parent = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			starts++;
			if (starts > 1) throw new Error("The parent was restarted");
			yield {
				priority: TaskPriority.Normal,
				task: async function* () {},
			};
			return "ok";
		},
	});

	t.expect(await parent).toBe("ok");
	t.expect(starts).toBe(1);

	await scheduler.stop();
});

test("A restarted parent ignores the result of a subtask removed before the restart", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	const child1Started = createDeferredPromise<void>();
	const child2Started = createDeferredPromise<void>();
	const child2Gate = createDeferredPromise<void>();
	const cleanupStarted = createDeferredPromise<void>();
	const cleanupGate = createDeferredPromise<void>();
	let childRuns = 0;
	let starts = 0;

	const parent = scheduler.queueTask({
		name: "parent",
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			if (++starts > 2)
				throw new Error("The parent was restarted too often");
			order.push("1a");
			yield {
				name: "child",
				priority: TaskPriority.Normal,
				task: async function* () {
					const run = ++childRuns;
					order.push(`2a${run}`);
					if (run === 1) {
						child1Started.resolve();
						yield () => new Promise(() => {});
					} else {
						child2Started.resolve();
						yield () => child2Gate;
					}
				},
				cleanup: async () => {
					if (childRuns > 1) return;
					order.push("2b");
					cleanupStarted.resolve();
					await cleanupGate;
				},
			};
			order.push("1b");
			return "ok";
		},
	});

	await child1Started;
	await wait(1);
	const removed = scheduler.removeTasks((t) => t.name === "child");
	await cleanupStarted;

	// Wake up the scheduler, so it picks the parent while the removed subtask cleans up
	const low = scheduler.queueTask({
		priority: TaskPriority.Low,
		task: async function* () {
			order.push("4a");
		},
	});
	await wait(1);

	// Interrupt the parent, so it gets reset and restarted
	await scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {
			order.push("3a");
		},
	});
	await child2Started;

	// Reject the removed subtask while the restarted parent waits for its new subtask
	cleanupGate.resolve();
	t.expect(await removed).toBe(true);
	await wait(1);
	child2Gate.resolve();

	t.expect(await parent).toBe("ok");
	await low;
	t.expect(order).toStrictEqual([
		"1a",
		"2a1",
		"2b",
		"3a",
		"1a",
		"2a2",
		"1b",
		"4a",
	]);

	await scheduler.stop();
});

for (const outcome of ["fulfilled", "rejected"] as const) {
	test(`A restarted task ignores the promise it waited for before the restart when it gets ${outcome}`, async (t) => {
		const scheduler = new TaskScheduler();
		const order: string[] = [];
		scheduler.start();

		const promise1 = createDeferredPromise<string>();
		const promise2 = createDeferredPromise<string>();
		const waiting1 = createDeferredPromise<void>();
		const waiting2 = createDeferredPromise<void>();
		let starts = 0;

		const task1 = scheduler.queueTask({
			priority: TaskPriority.Normal,
			interrupt: TaskInterruptBehavior.Restart,
			task: async function* () {
				const run = ++starts;
				order.push(`1a${run}`);
				if (run === 1) {
					waiting1.resolve();
					yield () => promise1;
					order.push("1b1");
				} else {
					waiting2.resolve();
					const result = (yield () => promise2) as string;
					order.push(`1b2 ${result}`);
				}
				return "ok";
			},
		});

		await waiting1;
		await wait(1);
		// Interrupt task 1 while it waits, so it gets reset and restarted
		await scheduler.queueTask({
			priority: TaskPriority.High,
			task: async function* () {
				order.push("2a");
			},
		});
		await waiting2;

		// Settle the old promise while the restarted task waits for the new one
		if (outcome === "fulfilled") {
			promise1.resolve("stale");
		} else {
			promise1.reject(new Error("stale"));
		}
		await wait(1);

		// Wake up the scheduler, so it steps task 1 again before the new promise settles
		const low = scheduler.queueTask({
			priority: TaskPriority.Low,
			task: async function* () {
				order.push("3a");
			},
		});
		await wait(1);
		t.expect(order).toStrictEqual(["1a1", "2a", "1a2"]);

		promise2.resolve("done");

		t.expect(await task1).toBe("ok");
		await low;
		t.expect(order).toStrictEqual(["1a1", "2a", "1a2", "1b2 done", "3a"]);

		await scheduler.stop();
	});
}

test("A restarted task receives the result of its new promise when the old one is fulfilled right after it", async (t) => {
	const scheduler = new TaskScheduler();
	scheduler.start();

	const promise1 = createDeferredPromise<string>();
	const promise2 = createDeferredPromise<string>();
	const waiting1 = createDeferredPromise<void>();
	const waiting2 = createDeferredPromise<void>();
	let starts = 0;

	const task1 = scheduler.queueTask({
		priority: TaskPriority.Normal,
		interrupt: TaskInterruptBehavior.Restart,
		task: async function* () {
			if (++starts === 1) {
				waiting1.resolve();
				yield () => promise1;
				return "stale run";
			}
			waiting2.resolve();
			return (yield () => promise2) as string;
		},
	});

	await waiting1;
	await wait(1);
	// Interrupt task 1 while it waits, so it gets reset and restarted
	await scheduler.queueTask({
		priority: TaskPriority.High,
		task: async function* () {},
	});
	await waiting2;
	await wait(1);

	// Fulfill the old promise in the same tick, after the new one
	promise2.resolve("done");
	promise1.resolve("stale");

	t.expect(await task1).toBe("done");

	await scheduler.stop();
});

test("A higher-priority task queued while a parent spawns a non-interruptible subtask runs first", async (t) => {
	const scheduler = new TaskScheduler();
	const order: string[] = [];
	scheduler.start();

	let high: Promise<void> | undefined;
	const parent = scheduler.queueTask({
		priority: TaskPriority.Normal,
		task: async function* () {
			order.push("1a");
			high = scheduler.queueTask({
				priority: TaskPriority.High,
				task: async function* () {
					order.push("3a");
				},
			});
			yield {
				priority: TaskPriority.Normal,
				interrupt: TaskInterruptBehavior.Forbidden,
				task: async function* () {
					order.push("2a");
				},
			};
			order.push("1b");
		},
	});

	await parent;
	await high;
	t.expect(order).toStrictEqual(["1a", "3a", "2a", "1b"]);

	await scheduler.stop();
});
