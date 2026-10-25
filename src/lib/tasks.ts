import { create } from "zustand";

/**
 * Long-running work shown in the sidebar task indicator: file transfers,
 * APK installs, bugreports. Features upsert their tasks by id.
 */
export interface Task {
  id: string;
  kind: "transfer" | "install" | "bugreport" | "other";
  label: string;
  /** 0..1, or null while the size is unknown. */
  progress: number | null;
  status: "running" | "done" | "failed" | "cancelled";
}

interface TasksState {
  tasks: Task[];
  upsert: (task: Task) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

export const useTasks = create<TasksState>()((set) => ({
  tasks: [],
  upsert: (task) =>
    set((s) => {
      const i = s.tasks.findIndex((t) => t.id === task.id);
      if (i < 0) return { tasks: [...s.tasks, task] };
      const tasks = s.tasks.slice();
      tasks[i] = task;
      return { tasks };
    }),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  clearFinished: () =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === "running") })),
}));
