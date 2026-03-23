const http = require('node:http');
const { executeRequest } = require('./index.js');

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
        res.writeHead(404)
        res.end('Not-found');
    });
    server.listen(port, ()=> {
        console.error("something")
    });

}
module.exports = {startUIServer};