# ![Waddle](docs/logo.jpg)

## A cooperative task scheduler

### Install

```
npm install @zwave-js/waddle
```

### Usage

To use the task scheduler, create a new instance and start it:

```js
const scheduler = new TaskScheduler();
scheduler.start();
```

Afterwards you can queue tasks and they will automatically be executed. Each task is simply a [generator function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/function*) that can `yield` to the scheduler at any time. Thi will allow other tasks to run - hence the name "cooperative task scheduler".

```js
const order = [];

// Start a task with normal priority
const task1 = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		order.push("1a");
		// Simulate some work
		await wait(1);
		// Then yield to the scheduler
		yield;

		order.push("1b");
		await wait(1);
		yield;

		order.push("1c");
		return 1;
	},
});

// Start a task with high priority
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
		return 2;
	},
});
```

`queueTask` return a Promise that resolves to the value the task returns. This way you can wait for the task to finish and return values from them:

```js
const results = await Promise.all([task1, task2]);
console.log(results); // [1, 2]
```

Each task has a priority that determines in which order the tasks are executed. Looking at the above example, we can see that task 2 has a higher priority than task 1. Once task 1 yields to the scheduler, task 2 will start executing. Because task 2 has a higher priority, it will run to completion before task 1 continues:

```js
console.log(order); // ["1a", "2a", "2b", "2c", "1b", "1c"]
```

To stop the scheduler, simply...

```js
await scheduler.stop();
```

#### Identifying tasks

To identify individual tasks, e.g. for canceling them (see below), you can pass additional information to the task builder. This is all optional:

```js
const task2 = scheduler.queueTask({
  // A human-readable name for the task
  name: "My Task",
  // Information to programmatically identify the task
  tag: {
    id: "my-task",
    argument: 42,
  }
	priority: TaskPriority.High,
	task: async function* () {
    // ...
	},
});
```

The `tag` must be an object that has at least a string `id`. It is recommended to use a custom type for this to be able to distinguish related tasks. For example:

```ts
export type TaskTag =
	| {
			// Rebuild routes for all nodes
			id: "rebuild-routes";
	  }
	| {
			// Rebuild routes for a single node
			id: "rebuild-node-routes";
			nodeId: number;
	  }
	| {
			// Perform an OTA firmware update for a node
			id: "firmware-update-ota";
			nodeId: number;
	  };
```

This information can also be used to retrieve a task from the scheduler:

```js
const task = scheduler.findTask((task) => task.tag?.id === "rebuild-routes");
//    ^ Either a Promise or undefined, depending on whether the task exists or not
```

#### Task Priority

There are several task priorities defined:

```ts
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
```

When a task yields, the scheduler may switch to a different task. Tasks of equal priority will be interleaved, while tasks with higher priority will run to completion before lower priority tasks are resumed. Tasks with lower priority will not run as long as there are tasks with a higher priority pending.

#### Interrupt Behavior

You can also specify how the scheduler should behave when the task is at a yield point. The following interrupt behaviors are available:

```ts
export enum TaskInterruptBehavior {
	/** The task may not be interrupted */
	Forbidden,
	/** The task will be resumed after being interrupted (default) */
	Resume,
	/** The task needs to be restarted after being interrupted */
	Restart,
}
```

By default, all tasks will simply be resumed where they left off when the scheduler wants to run them again.
You can also specify that a task needs to be restarted from the beginning after being interrupted by a higher priority task.
Additionally, some tasks can be marked as not interruptible. This means that even if they reach a point where they could be interrupted and a higher priority task is pending, they will not be interrupted.

#### Waiting while yielding

The previous examples showed how to yield to the scheduler, which is fine for most cases.

When asynchronously performing work that takes a while to complete, simply `await`ing that would block the scheduler and is therefore not recommended:

```js
// ❌ Do not do this!
async function* fetchResourcesTask() {
	// These 3 calls will all run in a block without allowing other tasks to run:
	await doLongRunningWork1();
	await doLongRunningWork2();
	await doLongRunningWork3();
}
```

Instead, the `Promise` that should be awaited can be passed back to the scheduler, so it knows when the task is ready to continue. This is done by `yield`ing a function that returns the `Promise`, like so:

```js
// ✅ Do this instead!
async function* fetchResourcesTask() {
	yield () => doLongRunningWork1();
	yield () => doLongRunningWork2();
	yield () => doLongRunningWork3();
}
```

At each `yield` point, the task will be suspended and the scheduler can run other tasks. Once the returned `Promise` resolves (and another task is ready to yield), the original task will be resumed.

You can also use the results of the `Promise` in the task:

```js
async function* fetchResourcesTask() {
	const result1 = yield () => doLongRunningWork1();
	const result2 = yield () => doLongRunningWork2();
	const result3 = yield () => doLongRunningWork3();

	// Do something with the results
	console.log(result1, result2, result3);
}
```

When using TypeScript, you may need to assert the return type due to limits in type inference in generator functions:

```ts
async function* fetchResourcesTask() {
	// async function doLongRunningWork1(): Promise<string> { ... }
	const result1 = (yield () => doLongRunningWork1()) as string;
	// async function doLongRunningWork2(): Promise<number> { ... }
	const result2 = (yield () => doLongRunningWork2()) as number;
	// async function doLongRunningWork3(): Promise<boolean> { ... }
	const result3 = (yield () => doLongRunningWork3()) as boolean;

	// Do something with the results
	console.log(result1, result2, result3);
}
```

#### Waiting for subtasks

If a task depends on the results of another task, the parent task can also ask the scheduler to execute that task and wait for it to finish.
This can be done by yielding a `TaskBuilder` object, which is what you'd normally pass to `queueTask`:

```js
const childTaskBuilder = {
	priority: TaskPriority.Normal,
	task: async function* () {
		// Do some work
		await wait(1);
		return 42;
	},
};

const parentTask = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		const childResult = yield childTaskBuilder;
		return childResult + 1;
	},
});

const result = await parentTask;
console.log(result); // 43
```

Like with yielding Promises, you may need to help TypeScript with the return type:

```ts
// [...]
const parentTask = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		const childResult = (yield childTaskBuilder) as number;
		return childResult + 1;
	},
});
```

#### Calling other generator functions

In JavaScript, a generator function can call another generator function and forward its results using the `yield*` operator:

```js
function* generator1() {
	yield 1;
	yield 2;
}
function* generator2() {
	yield* generator1();
	yield 3;
}
for (const value of generator2()) {
	console.log(value); // 1, 2, 3
}
```

The same principle can be used to split tasks into multiple functions:

```js
async function* task1() {
	yield () => doLongRunningWork1();
	yield () => doLongRunningWork2();
}
async function* task2() {
	yield () => doLongRunningWork3();
	yield () => doLongRunningWork4();
}
async function* mainTask() {
	yield* task1();
	yield* task2();
}

const task = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: mainTask,
});
```

This task will yield to the scheduler at each `yield` point in the `task1` and `task2` functions, just as if they were all in the same function.

#### Error handling

If a task throws an error, the scheduler will catch it and reject the `Promise` returned by `queueTask`. The error can be handled like any other Promise:

```js
const task = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		throw new Error("Something went wrong");
	},
});
try {
	await task;
} catch (error) {
	console.error(error); // Error: Something went wrong
}
```

The same is true for yielded Promises

```js
const task = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		try {
			yield () => someWorkThatMightFail();
		} catch (error) {
			console.error(error); // Error: Something went wrong
		}
	},
});
```

or for subtasks:

```js
const childTaskBuilder = {
	priority: TaskPriority.Normal,
	task: async function* () {
		throw new Error("Something went wrong");
	},
};

const parentTask = scheduler.queueTask({
	priority: TaskPriority.Normal,
	task: async function* () {
		try {
			yield childTaskBuilder;
		} catch (error) {
			console.error(error); // Error: Something went wrong
		}
	},
});
```

#### Canceling tasks

To cancel one or more tasks, simply call the `scheduler.removeTasks` method. This method takes a predicate function that will be called for each active and queued task. If the predicate returns `true`, the task will be removed from the scheduler. This can be used to cancel tasks that are no longer needed.

Note that running tasks will not be canceled immediately. Instead they will run until the next `yield` point first.

```js
// Cancel all tasks
scheduler.removeTasks(() => true);
```

You can also access the task's `name` and `tag` properties (see above) to decide which tasks to cancel:

```js
// Cancel all rebuild routes tasks
scheduler.removeTasks((task) => task.tag?.id === "rebuild-routes");
```

The function will resolve to `true` if at least one task was canceled, or `false` if no tasks were canceled:

```js
const canceled = await scheduler.removeTasks(
	(task) => task.tag?.id === "rebuild-routes",
);
if (canceled) {
	console.log("Canceled all rebuild routes tasks");
} else {
	console.log("No tasks were canceled");
}
```

Canceled tasks will result in an `Error`. Take care of this when awaiting them!

By default, each canceled tasks will be rejected with this error:

```js
new Error("Task was removed");
```

To customize the behavior, either pass a custom error to the `removeTasks` method

```js
const canceled = await scheduler.removeTasks(
	() => true,
	new Error("We are all doomed!"),
);
```

or customize the default error by passing a custom error factory to the `TaskScheduler` constructor:

```js
const scheduler = new TaskScheduler(() => new Error("We are all doomed!"));
```
