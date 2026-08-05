'use client';

import { useState } from 'react';
import useAdminStore from '@/store/adminStore';
import { adminInputClass } from './AdminUi';

export default function SetApiKeyModal({ isOpen, onClose, initialAuthId = null, onKeySet }) {
  const [apiKey, setApiKeyInput] = useState('');
  const [keyName, setKeyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [createdKeyData, setCreatedKeyData] = useState(null);
  const [copied, setCopied] = useState(false);

  const setApiKeyForUser = useAdminStore((s) => s.setApiKeyForUser);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setCreatedKeyData(null);

    try {
      const res = await setApiKeyForUser({
        apiKey: apiKey.trim() || undefined,
        keyName: keyName.trim() || undefined,
        authId: initialAuthId || undefined,
      });

      if (!res.success) {
        setError(res.error || 'Failed to set API key');
      } else {
        setCreatedKeyData(res.data);
        onKeySet?.(res.data);
      }
    } catch (err) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (createdKeyData?.api_key) {
      navigator.clipboard.writeText(createdKeyData.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setApiKeyInput('');
    setKeyName('');
    setError(null);
    setCreatedKeyData(null);
    setCopied(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-white p-6 shadow-2xl dark:border-border-dark dark:bg-surface-alt-dark">
        <h3 className="text-lg font-bold text-text dark:text-text-dark">
          {createdKeyData ? '🔑 API Key Created / Set' : '🔑 Set User API Key'}
        </h3>
        <p className="mt-1 text-xs text-muted dark:text-muted-dark">
          {createdKeyData
            ? 'Key has been stored securely in MongoDB database.'
            : 'Set a custom API key or auto-generate a new secure key for the user.'}
        </p>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
            {error}
          </div>
        )}

        {createdKeyData ? (
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-semibold text-muted dark:text-muted-dark">
                Auth ID
              </label>
              <p className="font-mono text-xs font-medium text-text dark:text-text-dark break-all">
                {createdKeyData.auth_id}
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted dark:text-muted-dark">
                API Key
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={createdKeyData.api_key}
                  className={`${adminInputClass} font-mono text-xs text-accent dark:text-accent-dark`}
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="ui-btn-accent shrink-0 text-xs px-3 py-2"
                >
                  {copied ? 'Copied! ✓' : 'Copy'}
                </button>
              </div>
            </div>

            {createdKeyData.key_name && (
              <div>
                <label className="text-xs font-semibold text-muted dark:text-muted-dark">
                  Key Name
                </label>
                <p className="text-xs text-text dark:text-text-dark">{createdKeyData.key_name}</p>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button type="button" onClick={handleClose} className="ui-btn-accent text-sm">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-text dark:text-text-dark">
                Key Name <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Primary Key"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className={`${adminInputClass} mt-1`}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-text dark:text-text-dark">
                Custom API Key <span className="font-normal text-muted">(leave empty to auto-generate)</span>
              </label>
              <input
                type="text"
                placeholder="Leave blank to generate tb_..."
                value={apiKey}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className={`${adminInputClass} mt-1 font-mono text-xs`}
              />
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className="ui-btn-ghost text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="ui-btn-accent text-xs disabled:opacity-50"
              >
                {loading ? 'Setting Key...' : apiKey.trim() ? 'Set Key' : 'Generate & Set Key'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
