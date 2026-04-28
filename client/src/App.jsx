import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ProjectWizard from './pages/ProjectWizard.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import SeriesPage from './pages/SeriesPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id" element={<ProjectWizard />} />
          <Route path="/projects/:id/detail" element={<ProjectDetail />} />
          <Route path="/series" element={<SeriesPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
