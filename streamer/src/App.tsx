import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface StreamStatus {
  cam_id: string;
  active: boolean;
  error: string | null;
}

function App() {
  const [serverUrl, setServerUrl] = useState("localhost:2343");
  const [rtspUrls, setRtspUrls] = useState<Record<string, string>>({
    cam1: "",
    cam2: "",
    cam3: "",
    cam4: "",
  });
  const [statuses, setStatuses] = useState<StreamStatus[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => {
    setLog((prev) => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const refreshStatus = async () => {
    try {
      const result = await invoke<StreamStatus[]>("get_status");
      setStatuses(result);
    } catch (e) {
      addLog(`Status error: ${e}`);
    }
  };

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const startStream = async (camId: string) => {
    const rtspUrl = rtspUrls[camId];
    if (!rtspUrl.trim()) {
      addLog(`No RTSP URL set for ${camId}`);
      return;
    }
    try {
      const result = await invoke<string>("start_stream", {
        serverUrl,
        config: { cam_id: camId, rtsp_url: rtspUrl },
      });
      addLog(result);
      refreshStatus();
    } catch (e) {
      addLog(`Error starting ${camId}: ${e}`);
    }
  };

  const stopStream = async (camId: string) => {
    try {
      const result = await invoke<string>("stop_stream", { camId });
      addLog(result);
      refreshStatus();
    } catch (e) {
      addLog(`Error stopping ${camId}: ${e}`);
    }
  };

  const stopAll = async () => {
    try {
      const result = await invoke<string>("stop_all");
      addLog(result);
      refreshStatus();
    } catch (e) {
      addLog(`Error: ${e}`);
    }
  };

  const startAll = async () => {
    for (const camId of ["cam1", "cam2", "cam3", "cam4"]) {
      if (rtspUrls[camId].trim()) {
        await startStream(camId);
      }
    }
  };

  const getStatus = (camId: string): StreamStatus | undefined =>
    statuses.find((s) => s.cam_id === camId);

  return (
    <div className="app">
      <h1>RTSP Streamer</h1>

      <div className="server-config">
        <label>Backend Server</label>
        <input
          type="text"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="ip:port (e.g. 192.168.1.100:2343)"
        />
      </div>

      <div className="cameras">
        {["cam1", "cam2", "cam3", "cam4"].map((camId) => {
          const status = getStatus(camId);
          const isActive = status?.active ?? false;
          return (
            <div key={camId} className="camera-row">
              <div className="camera-header">
                <span className="camera-label">{camId.toUpperCase()}</span>
                <span className={`status-dot ${isActive ? "active" : ""}`} />
              </div>
              <input
                type="text"
                value={rtspUrls[camId]}
                onChange={(e) =>
                  setRtspUrls((prev) => ({ ...prev, [camId]: e.target.value }))
                }
                placeholder="rtsp://user:pass@ip:port/path"
                disabled={isActive}
              />
              <div className="camera-actions">
                {isActive ? (
                  <button className="btn-stop" onClick={() => stopStream(camId)}>
                    Stop
                  </button>
                ) : (
                  <button className="btn-start" onClick={() => startStream(camId)}>
                    Start
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="global-actions">
        <button className="btn-start" onClick={startAll}>Start All</button>
        <button className="btn-stop" onClick={stopAll}>Stop All</button>
      </div>

      <div className="log">
        <h3>Log</h3>
        <div className="log-entries">
          {log.map((entry, i) => (
            <div key={i} className="log-entry">{entry}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
