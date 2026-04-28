import { safeReadJson, projectPath, fileExists } from '../utils/fileHelpers.js';

export async function validateProject(req, res, next) {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Project ID is required' });
  }

  const projectFile = projectPath(id, 'project.json');
  const exists = await fileExists(projectFile);
  if (!exists) {
    return res.status(404).json({ error: `Project ${id} not found` });
  }

  const project = await safeReadJson(projectFile);
  if (!project) {
    return res.status(500).json({ error: 'Failed to read project data' });
  }

  req.project = project;
  next();
}
