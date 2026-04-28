import { EventEmitter } from 'events';

export const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);

export function emit(projectId, step, message, percent) {
  progressEmitter.emit(projectId, { step, message, percent });
}

// Job queue: Map of projectId -> Promise
const activeJobs = new Map();

export async function runJob(projectId, jobFn) {
  if (activeJobs.has(projectId)) {
    throw new Error('Job already running for this project');
  }
  const job = jobFn().finally(() => activeJobs.delete(projectId));
  activeJobs.set(projectId, job);
  return job;
}

export function isRunning(projectId) {
  return activeJobs.has(projectId);
}
