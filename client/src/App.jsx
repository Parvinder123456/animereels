import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import VideoExplainerPage from './pages/VideoExplainerPage.jsx';
import TranslatePage from './pages/TranslatePage.jsx';
import ShortsPage from './pages/ShortsPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id/explainer" element={<VideoExplainerPage />} />
          <Route path="/projects/:id/translate" element={<TranslatePage />} />
          <Route path="/projects/:id/shorts" element={<ShortsPage />} />
          {/* Legacy routes redirect to explainer */}
          <Route path="/projects/:id" element={<VideoExplainerPage />} />
          <Route path="/projects/:id/video" element={<VideoExplainerPage />} />
          <Route path="/projects/:id/detail" element={<VideoExplainerPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
