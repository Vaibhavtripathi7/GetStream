import { useState } from 'react';

function App(){

  const [url , seturl] = useState('https://httpbin.org/get');
  const [method, setMethod] = useState('GET');
  const [response, setResponse] = useState('Hit send to see the response...');
  const [body, setBody] = useState("")
  const [status, setStatus] = useState(null);
  const [time, setTime] = useState(null)

  const handleSend = async () => {
    setResponse('Waiting for response...');
    setStatus(null)
    setTime(null);
    try {
      
      const res = await fetch('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: url,
          method: method,
          body: method === 'POST' ? body: undefined ,
          timeout: 5000
        })
      });
      const data = await res.json();
      if(data.error){
        setResponse(`error: ${data.error}`);
        setStatus('ERROR');

      }else {
        try {
          const parsed = JSON.parse(data.data)
          setResponse(JSON.stringify(parsed, null, 2));

        } catch{
          setResponse(data.data)
        }
        setStatus(data.status);
        setTime(data.time);
      }
    } catch (error) {
      setResponse(`fatal error`)
      setStatus('503');
    }
  };

  return (
      <div style={{ display: 'flex', height: '100vh', padding: '20px', gap: '20px', boxSizing: 'border-box' }}>
        
        {/* LEFT PANE: CONTROLS */}
        <div style={{ flex: '0 0 350px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <h2 style={{ margin: '0 0 10px 0', color: 'var(--accent)', fontSize: '1.2rem' }}>
            ⚡ Postman-CLI
          </h2>

          <div style={{ display: 'flex', gap: '10px' }}>
            <select 
              value={method} 
              onChange={(e) => setMethod(e.target.value)}
              style={{ background: 'var(--bg-panel)', color: 'var(--accent)', border: '1px solid var(--border)', padding: '10px', borderRadius: '6px', fontWeight: 'bold', outline: 'none', cursor: 'pointer' }}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <input 
              type="text" 
              value={url} 
              onChange={(e) => setUrl(e.target.value)}
              style={{ flex: 1, background: 'var(--bg-panel)', color: 'white', border: '1px solid var(--border)', padding: '10px', borderRadius: '6px', outline: 'none', fontFamily: 'inherit' }}
              placeholder="https://api.com"
            />
          </div>

          {method === 'POST' && (
            <textarea 
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"key": "value"}'
              style={{ height: '150px', background: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border)', padding: '10px', borderRadius: '6px', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
            />
          )}

          <button 
            onClick={handleSend}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '12px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}
            onMouseOver={(e) => e.target.style.opacity = 0.8}
            onMouseOut={(e) => e.target.style.opacity = 1}
          >
            EXECUTE
          </button>
        </div>

        {/* RIGHT PANE: RESPONSE MATRIX */}
        <div style={{ flex: 1, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          
          {/* Status Bar */}
          <div style={{ background: '#010409', padding: '10px 15px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
            <span style={{ color: '#8b949e' }}>Network Response</span>
            <div>
              {status && <span style={{ color: status >= 200 && status < 300 ? 'var(--success)' : 'var(--error)', marginRight: '15px', fontWeight: 'bold' }}>Status: {status}</span>}
              {time && <span style={{ color: '#8b949e' }}>Time: {time}ms</span>}
            </div>
          </div>

          {/* JSON Payload */}
          <pre style={{ margin: 0, padding: '15px', overflowY: 'auto', flex: 1, color: 'var(--success)', fontSize: '0.95rem', lineHeight: '1.5' }}>
            {response}
          </pre>

        </div>
      </div>
    );
  }
export default App;