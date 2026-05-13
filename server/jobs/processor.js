import { EventEmitter } from 'events';

export const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);

export function emit(projectId, step, message, percent) {
  progressEmitter.emit(projectId, { step, message, percent });
}

// Job queue: Map of projectId -> { promise, startedAt }
const activeJobs = new Map();

// Stale job timeout: if a job has been running longer than this, allow overriding it.
const STALE_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runJob(projectId, jobFn) {
  const existing = activeJobs.get(projectId);
  if (existing) {
    const elapsed = Date.now() - existing.startedAt;
    if (elapsed < STALE_JOB_TIMEOUT_MS) {
      throw new Error('Job already running for this project');
    }
    // Stale job — likely from a server reload where the ffmpeg process died
    // but the promise never settled. Clear it and allow a new job.
    activeJobs.delete(projectId);
  }
  const entry = { promise: null, startedAt: Date.now() };
  entry.promise = jobFn().finally(() => activeJobs.delete(projectId));
  activeJobs.set(projectId, entry);
  return entry.promise;
}

export function isRunning(projectId) {
  const existing = activeJobs.get(projectId);
  if (!existing) return false;
  const elapsed = Date.now() - existing.startedAt;
  if (elapsed >= STALE_JOB_TIMEOUT_MS) {
    activeJobs.delete(projectId);
    return false;
  }
  return true;
}

/** Force-clear a stuck job (e.g. from admin/debug route). */
export function cancelJob(projectId) {
  activeJobs.delete(projectId);
}
