import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi } from 'vitest';
import { server } from './mocks/server';
import { FileBrowser } from '../components/FileBrowser';

describe('FileBrowser', () => {
  describe('File List Display', () => {
    it('displays file list', async () => {
      render(<FileBrowser />);

      expect(await screen.findByText('photo.jpg')).toBeInTheDocument();
      expect(screen.getByText('Documents')).toBeInTheDocument();
    });

    it('shows file icons based on type', async () => {
      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      // File should have file icon, directory should have folder icon
      const fileItem = screen.getByText('photo.jpg').closest('[data-testid="file-item"]');
      const dirItem = screen.getByText('Documents').closest('[data-testid="file-item"]');

      expect(fileItem).toHaveAttribute('data-type', 'file');
      expect(dirItem).toHaveAttribute('data-type', 'directory');
    });

    it('shows file sizes for files', async () => {
      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      // File size should be displayed (1024 bytes = 1 KB)
      expect(screen.getByText(/1.*KB/i)).toBeInTheDocument();
    });

    it('shows loading state initially', () => {
      render(<FileBrowser />);

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });

    it('handles API error gracefully', async () => {
      server.use(
        http.get('/api/files', () => {
          return HttpResponse.json({ error: 'Failed to load files' }, { status: 500 });
        })
      );

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
    });
  });

  describe('Directory Navigation', () => {
    it('navigates into directory on click', async () => {
      const user = userEvent.setup();

      server.use(
        http.get('/api/files', ({ request }) => {
          const url = new URL(request.url);
          const path = url.searchParams.get('path') || '/';

          if (path === '/Documents') {
            return HttpResponse.json({
              files: [
                { name: 'report.pdf', type: 'file', size: 2048 },
              ],
            });
          }

          return HttpResponse.json({
            files: [
              { name: 'photo.jpg', type: 'file', size: 1024 },
              { name: 'Documents', type: 'directory' },
            ],
          });
        })
      );

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('Documents')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Documents'));

      await waitFor(() => {
        expect(screen.getByText('report.pdf')).toBeInTheDocument();
      });
    });

    it('shows current path breadcrumb', async () => {
      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      // Root path should be shown
      expect(screen.getByText(/\//)).toBeInTheDocument();
    });

    it('allows navigating back to parent', async () => {
      const user = userEvent.setup();

      server.use(
        http.get('/api/files', ({ request }) => {
          const url = new URL(request.url);
          const path = url.searchParams.get('path') || '/';

          if (path === '/Documents') {
            return HttpResponse.json({
              files: [
                { name: 'report.pdf', type: 'file', size: 2048 },
              ],
            });
          }

          return HttpResponse.json({
            files: [
              { name: 'photo.jpg', type: 'file', size: 1024 },
              { name: 'Documents', type: 'directory' },
            ],
          });
        })
      );

      render(<FileBrowser />);

      // Navigate into Documents
      await waitFor(() => {
        expect(screen.getByText('Documents')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Documents'));

      await waitFor(() => {
        expect(screen.getByText('report.pdf')).toBeInTheDocument();
      });

      // Navigate back
      const backButton = screen.getByRole('button', { name: /back/i });
      await user.click(backButton);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });
    });
  });

  describe('File Selection', () => {
    it('selects file on click', async () => {
      const user = userEvent.setup();
      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      await user.click(screen.getByText('photo.jpg'));

      // Should show selection state
      const fileItem = screen.getByText('photo.jpg').closest('[data-testid="file-item"]');
      expect(fileItem).toHaveClass('selected');
    });

    it('allows multiple selection with ctrl/cmd', async () => {
      const user = userEvent.setup();

      server.use(
        http.get('/api/files', () => {
          return HttpResponse.json({
            files: [
              { name: 'file1.txt', type: 'file', size: 100 },
              { name: 'file2.txt', type: 'file', size: 200 },
              { name: 'file3.txt', type: 'file', size: 300 },
            ],
          });
        })
      );

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('file1.txt')).toBeInTheDocument();
      });

      // Select first file
      await user.click(screen.getByText('file1.txt'));

      // Ctrl+click second file
      await user.keyboard('{Control>}');
      await user.click(screen.getByText('file2.txt'));
      await user.keyboard('{/Control}');

      // Both should be selected
      const file1 = screen.getByText('file1.txt').closest('[data-testid="file-item"]');
      const file2 = screen.getByText('file2.txt').closest('[data-testid="file-item"]');
      expect(file1).toHaveClass('selected');
      expect(file2).toHaveClass('selected');
    });
  });

  describe('File Upload', () => {
    it('uploads file via file input', async () => {
      const user = userEvent.setup();
      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      const uploadInput = screen.getByLabelText(/upload/i);
      await user.upload(uploadInput, file);

      await waitFor(() => {
        expect(screen.getByText(/uploaded successfully/i)).toBeInTheDocument();
      });
    });

    it('shows upload progress', async () => {
      const user = userEvent.setup();
      const file = new File(['hello world content'], 'test.txt', { type: 'text/plain' });

      // Delay the upload response
      server.use(
        http.post('/api/files/upload', async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return HttpResponse.json({ success: true, message: 'Uploaded successfully' });
        })
      );

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      const uploadInput = screen.getByLabelText(/upload/i);
      await user.upload(uploadInput, file);

      // Should show uploading state
      expect(screen.getByText(/uploading/i)).toBeInTheDocument();
    });

    it('handles upload error', async () => {
      const user = userEvent.setup();
      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

      server.use(
        http.post('/api/files/upload', () => {
          return HttpResponse.json({ error: 'Upload failed' }, { status: 500 });
        })
      );

      render(<FileBrowser />);

      await waitFor(() => {
        expect(screen.getByText('photo.jpg')).toBeInTheDocument();
      });

      const uploadInput = screen.getByLabelText(/upload/i);
      await user.upload(uploadInput, file);

      await waitFor(() => {
        expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
      });
    });
  });

  describe('File Download', () => {
    it('downloads file on download button click', async () => {
      const user = userEvent.setup();
      const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
      const mockRevokeObjectURL = vi.fn();
      URL.createObjectURL = mockCreateObjectURL;
      URL.revokeObjectURL = mockRevokeObjectURL;

      render(<FileBrowser />);

      const photoFile = await screen.findByText('photo.jpg');
      expect(photoFile).toBeInTheDocument();

      // Select file
      await user.click(photoFile);

      // Click download
      const downloadButton = screen.getByRole('button', { name: /download/i });
      await user.click(downloadButton);

      // Verify download was triggered (URL.createObjectURL should be called)
      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });
    });

    it('disables download when no file selected', async () => {
      render(<FileBrowser />);

      const photoFile = await screen.findByText('photo.jpg');
      expect(photoFile).toBeInTheDocument();

      const downloadButton = screen.getByRole('button', { name: /download/i });
      expect(downloadButton).toBeDisabled();
    });
  });

  describe('File Operations', () => {
    it('shows delete confirmation', async () => {
      const user = userEvent.setup();
      render(<FileBrowser />);

      const photoFile = await screen.findByText('photo.jpg');
      expect(photoFile).toBeInTheDocument();

      // Select file
      await user.click(photoFile);

      // Click delete
      const deleteButton = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteButton);

      // Confirmation should appear
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    });

    it('refreshes list after successful operation', async () => {
      const user = userEvent.setup();
      let callCount = 0;

      server.use(
        http.get('/api/files', () => {
          callCount++;
          if (callCount > 1) {
            return HttpResponse.json({
              files: [
                { name: 'new-file.txt', type: 'file', size: 500 },
              ],
            });
          }
          return HttpResponse.json({
            files: [
              { name: 'photo.jpg', type: 'file', size: 1024 },
              { name: 'Documents', type: 'directory' },
            ],
          });
        })
      );

      render(<FileBrowser />);

      const photoFile = await screen.findByText('photo.jpg');
      expect(photoFile).toBeInTheDocument();

      // Click refresh
      const refreshButton = screen.getByRole('button', { name: /refresh/i });
      await user.click(refreshButton);

      await waitFor(() => {
        expect(screen.getByText('new-file.txt')).toBeInTheDocument();
      });
    });
  });
});
