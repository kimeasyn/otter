CREATE UNIQUE INDEX one_active_unit_per_worktree ON work_units(worktree_path)
 WHERE status NOT IN ('completed','archived');
