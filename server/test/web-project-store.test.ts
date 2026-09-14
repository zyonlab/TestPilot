import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/lib/store';
import { api } from '../../src/lib/api';
import type { Project, TestCase, RunRecord } from '../../src/lib/types';

vi.mock('../../src/lib/api', () => ({ api: {
  getProjects: vi.fn(), getCases: vi.fn(), getRuns: vi.fn(), getFlakiness: vi.fn(),
} }));
const projects = ['a', 'b'].map(id => ({ id, name: id, targetUrl: 'http://localhost', targetPlatform: 'web' } as Project));
const cases = (id: string) => [{ id, projectId: id } as TestCase];
const runs = (id: string) => [{ id, projectId: id } as RunRecord];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  useStore.getState().exitProject();
  useStore.setState({ projects, overviews: {}, projectsLoading: false, projectsError: false, backendUp: true });
  vi.mocked(api.getProjects).mockResolvedValue({ projects });
  vi.mocked(api.getCases).mockImplementation(async id => ({ cases: cases(id!) }));
  vi.mocked(api.getRuns).mockImplementation(async opts => ({ runs: runs(opts!.projectId!) }));
  vi.mocked(api.getFlakiness).mockResolvedValue({ flakiness: [] });
});

describe('project navigation loading', () => {
  it('selects before history completes and keeps successful cases if history fails', async () => {
    const pending = deferred<{ cases: TestCase[] }>();
    vi.mocked(api.getCases).mockReturnValueOnce(pending.promise);
    vi.mocked(api.getRuns).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const loading = useStore.getState().selectProject('a');
    expect(useStore.getState()).toMatchObject({ activeProjectId: 'a', projectDataLoading: true, cases: [], runs: [] });
    pending.resolve({ cases: cases('a') });
    await loading;
    expect(useStore.getState()).toMatchObject({ activeProjectId: 'a', projectDataLoading: false, projectDataError: true, cases: cases('a'), runs: [] });
    await useStore.getState().selectProject('a');
    expect(useStore.getState()).toMatchObject({ projectDataError: false, runs: runs('a') });
  });

  it('does not clear the selected project when its list refreshes', async () => {
    await useStore.getState().selectProject('b');
    await useStore.getState().loadData();
    expect(useStore.getState()).toMatchObject({ activeProjectId: 'b', cases: cases('b'), runs: runs('b') });
  });

  it('reports list failure, preserves existing data, and supports retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(api.getProjects).mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await useStore.getState().loadData();
      expect(useStore.getState()).toMatchObject({ projects, backendUp: false, projectsError: true, projectsLoading: false });
      await useStore.getState().loadData();
      expect(useStore.getState()).toMatchObject({ projects, backendUp: true, projectsError: false });
    } finally { warning.mockRestore(); }
  });

  it('ignores old responses when switching A to B to A', async () => {
    const old = deferred<{ cases: TestCase[] }>();
    vi.mocked(api.getCases).mockReturnValueOnce(old.promise);
    const first = useStore.getState().selectProject('a');
    await useStore.getState().selectProject('b');
    await useStore.getState().selectProject('a');
    old.resolve({ cases: cases('stale') });
    await first;
    expect(useStore.getState()).toMatchObject({ activeProjectId: 'a', cases: cases('a'), runs: runs('a') });
  });

  it('does not restore project data after leaving the project', async () => {
    const pending = deferred<{ cases: TestCase[] }>();
    vi.mocked(api.getCases).mockReturnValueOnce(pending.promise);
    const loading = useStore.getState().selectProject('a');
    useStore.getState().exitProject();
    pending.resolve({ cases: cases('a') });
    await loading;
    expect(useStore.getState()).toMatchObject({ activeProjectId: '', cases: [], runs: [], projectDataLoading: false });
  });

  it('deduplicates concurrent list loads and clears a genuinely deleted selection', async () => {
    await useStore.getState().selectProject('a');
    const pending = deferred<{ projects: Project[] }>();
    vi.mocked(api.getProjects).mockReturnValueOnce(pending.promise);
    const first = useStore.getState().loadData();
    const second = useStore.getState().loadData();
    expect(second).toBe(first);
    expect(api.getProjects).toHaveBeenCalledTimes(1);
    pending.resolve({ projects: [] });
    await Promise.all([first, second]);
    expect(useStore.getState()).toMatchObject({ activeProjectId: '', projects: [], cases: [], runs: [], projectsError: false });
  });
});
