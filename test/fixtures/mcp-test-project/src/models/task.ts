/**
 * Task Model
 * @implements UC-001, UC-002
 * @architecture docs/architecture/cli/index.md
 */

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId?: string;
  workspaceId: string;
  dueDate?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export type TaskStatus = 'open' | 'in_progress' | 'review' | 'done' | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigneeId?: string;
  workspaceId: string;
  dueDate?: Date;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string;
  dueDate?: Date;
}
