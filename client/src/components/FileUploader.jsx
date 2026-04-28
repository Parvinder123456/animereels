import React, { useState, useRef, useEffect } from 'react';
import { post } from '../api/client.js';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px'
  },
  dropzone: {
    border: '2px dashed var(--glass-border)',
    borderRadius: '12px',
    padding: '48px 24px',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
    background: 'var(--glass-bg)'
  },
  dropzoneActive: {
    borderColor: 'var(--accent-purple)',
    background: 'rgba(139, 92, 246, 0.05)'
  },
  icon: {
    fontSize: '48px',
    marginBottom: '12px',
    display: 'block'
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    marginBottom: '8px'
  },
  subtitle: {
    fontSize: '13px',
    color: 'var(--text-muted)'
  },
  fileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    maxHeight: '200px',
    overflowY: 'auto'
  },
  fileItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: 'var(--bg-secondary)',
    borderRadius: '8px',
    fontSize: '13px'
  },
  fileName: {
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '300px'
  },
  fileSize: {
    color: 'var(--text-muted)',
    flexShrink: 0
  },
  actions: {
    display: 'flex',
    gap: '12px',
    justifyContent: 'flex-end'
  }
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function FileUploader({ projectId, onUploadComplete }) {
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const folderInputRef = useRef(null);

  const acceptTypes = '.jpg,.jpeg,.png,.webp';

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('mozdirectory', '');
    }
  }, []);

  function extractChapterNum(folderName) {
    const nums = folderName.match(/\d+/g);
    return nums ? parseInt(nums[nums.length - 1], 10) : null;
  }

  function handleFiles(fileList) {
    const arr = Array.from(fileList).filter(f =>
      /\.(jpe?g|png|webp)$/i.test(f.name)
    );
    setFiles(prev => [...prev, ...arr]);
    setError(null);
  }

  function handleFolderFiles(fileList) {
    const arr = Array.from(fileList).filter(f =>
      /\.(jpe?g|png|webp)$/i.test(f.name)
    );
    if (arr.length === 0) return;

    // Group by immediate parent folder using webkitRelativePath
    const byFolder = new Map();
    for (const file of arr) {
      const parts = (file.webkitRelativePath || file.name).split('/');
      // Use the folder one level above the file; if flat, use '_root'
      const folder = parts.length > 1 ? parts[parts.length - 2] : '_root';
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(file);
    }

    // Sort folders naturally (Chapter 2 < Chapter 10), then files within each folder
    const sortedFolders = [...byFolder.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );

    // Rename to ch0001_p001.jpg so the server sorts in exact chapter-page order
    // Use the chapter number from the folder name (e.g. "Chapter 2" → 2) so uploading
    // chapters separately preserves their real order instead of always starting at ch001.
    const renamedFiles = [];
    sortedFolders.forEach((folder, chIdx) => {
      const chNum = extractChapterNum(folder) ?? (chIdx + 1);
      const pages = byFolder.get(folder).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );
      pages.forEach((file, pageIdx) => {
        const ext = file.name.split('.').pop().toLowerCase();
        const newName = `ch${String(chNum).padStart(4, '0')}_p${String(pageIdx + 1).padStart(3, '0')}.${ext}`;
        renamedFiles.push(new File([file], newName, { type: file.type }));
      });
    });

    setFiles(prev => [...prev, ...renamedFiles]);
    setError(null);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  function removeFile(index) {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      files.forEach(f => formData.append('chapterImages', f));
      const result = await post(`/projects/${projectId}/upload`, formData);
      onUploadComplete?.(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div
        style={{ ...styles.dropzone, ...(dragging ? styles.dropzoneActive : {}) }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onClick={() => inputRef.current?.click()}
      >
        <span style={styles.icon}>+</span>
        <div style={styles.title}>Drop chapter images here</div>
        <div style={styles.subtitle}>
          Supports JPG, PNG, WebP -- or click to browse
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptTypes}
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFolderFiles(e.target.files)}
        />
      </div>

      <div style={{ textAlign: 'center' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>or </span>
        <button
          className="btn-secondary"
          style={{ fontSize: '13px', padding: '6px 14px' }}
          onClick={() => folderInputRef.current?.click()}
          disabled={uploading}
        >
          Select Chapter Folder
        </button>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Pick the folder containing your chapter subfolders — pages are auto-sorted by chapter order
        </div>
      </div>

      {files.length > 0 && (
        <>
          <div style={styles.fileList}>
            {files.map((f, i) => (
              <div key={i} style={styles.fileItem}>
                <span style={styles.fileName}>{f.name}</span>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <span style={styles.fileSize}>{formatSize(f.size)}</span>
                  <button
                    style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', fontSize: '16px' }}
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                  >
                    x
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={styles.actions}>
            <button className="btn-secondary" onClick={() => setFiles([])} disabled={uploading}>
              Clear All
            </button>
            <button className="btn-primary" onClick={handleUpload} disabled={uploading}>
              {uploading ? 'Uploading...' : `Upload & Split (${files.length} files)`}
            </button>
          </div>
        </>
      )}

      {error && (
        <div style={{ color: 'var(--error)', fontSize: '13px', padding: '8px' }}>
          {error}
        </div>
      )}
    </div>
  );
}
