import { HttpError } from "./errors.js";

/** Keep request work alive until its database accounting and cleanup have finished. */
export class ActiveTurns {
  private stopping = false;
  private active = new Set<{
    controller: AbortController;
    done: Promise<void>;
  }>();

  async run<T>(work: (controller: AbortController) => Promise<T>): Promise<T> {
    if (this.stopping)
      throw new HttpError(
        503,
        "Server is restarting. Please try again shortly.",
      );
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = { controller, done };
    this.active.add(task);
    try {
      return await work(controller);
    } finally {
      this.active.delete(task);
      finish();
    }
  }

  async close() {
    this.stopping = true;
    const tasks = [...this.active];
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map((task) => task.done));
  }
}
