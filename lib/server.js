const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { executeRequest } = require('./index.js');

const FILE_TYPES = {
    '.html':'text/html',
    '.js':'text/javascript',
    '.css':'text/css',
    '.svg':'image/svg+xml'
}


function startUIServer(port= 3000) {

    const server = http.createServer(async (req,res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS'){
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.url === '/api/execute' && req.method ==='POST'){
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', async () =>{
                try{
                    const config = JSON.parse(body);
                    const result = await executeRequest(config);
                    let responseData = '';
                    for await (const chunk of result.body){
                        responseData += Buffer.from(chunk).toString('utf-8');

                    }
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        status: result.status,
                        time: result.time,
                        data: responseData
                    }));
                }catch (error){
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({error: error.message}));
                }
            });
            return ;
        }

        const distPath = path.join(__dirname, '../ui/dist');
        let filePath = req.url === '/' ? '/index.html' : req.url;
        let fullpath = path.join(distPath, filePath);
        try {
            const content = fs.readFileSync(fullpath);
            const ext = path.extname(fullpath);

            res.writeHead(200, {'Content-Type' : FILE_TYPES[ext] || 'text/plain'});
            res.end(content);
        } catch (error) {
            if (error.code  === 'ENOENT'){
                res.writeHead(404);
                res.end("UI not found!")

            }else {
                res.writeHead(500);
                res.end("server error");

            }
        }
    });
    server.listen(port, ()=> {
        console.error("something")
    });

}
module.exports = {startUIServer};