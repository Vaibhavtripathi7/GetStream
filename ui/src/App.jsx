import { useState } from 'react';



function App(){

  const [url , seturl] = useState('https://httpbin.org/get');
  const [method, setMethod] = useState('GET');
  const [response, setResponse] = useState('Hit send to see the response...');
  const [body, setBody] = useState("")

  const handleSend = async () => {
    setResponse('Waiting for response...');
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

      }else {
        setResponse(`Status: ${data.status} (${data.time}ms \n\n${data.data})`);
      }
    } catch (error) {
      setResponse(`fatal error`)
    }
  };


  return (
    <div style={{padding: '50px', color: 'white', fontfamily: 'sans-serif',background: '#1e1e2e', color: '#cdd6f4', minHeight: '100vh'}}>
      <h1>Postman CLI Dashboard</h1>
      {/* The controlled form*/}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px'}}>
        {/* Method Dropdown */}
        <select value = {method} onChange={(e)=> setMethod(e.target.value)}
         style={{padding: '10px', fontSize: '16px'}}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>

        </select>
        {/* URL Input box */}
        <input
          type="text"
          value={url}
          onChange={(e)=> seturl(e.target.value)}
          style={{flex: 1, padding: '10px', fontSize: '16px'}}  
        />
        <button
         onClick={handleSend}
         style={{padding: '10px 20px', fontSize: '16px', cursor: 'pointer', background: '#89b4fa', color: '#11111b', border: 'none', fontWeight: 'bold'}}
        >
          SEND
          </button>
        <textarea type='text' value ={body} onChange={(e)=> setBody(e.target.value)} style = {{width: '100%', height: '100px', marginTop: '10px'}}> </textarea>

      </div>
      {/* THE RESPONSE WINDOW */}
      <div style={{ background: '#11111b', padding: '20px', borderRadius: '8px', border: '1px solid #45475a' }}>
        <h3 style={{ marginTop: 0, color: '#a6e3a1' }}>Response:</h3>
        <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
          {response}
        </pre>
      </div>
      <p>My C++ v8 engine is ready</p>
    </div>
  );
}
export default App;