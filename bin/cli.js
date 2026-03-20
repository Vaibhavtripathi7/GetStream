#!/usr/bin/env node
const fs  = require('node:fs')
const { parseArgs } = require('node:util');
const { executeRequest } = require('../lib/index.js')

const options = {
    url : {type: 'string', short: 'u'},
    method: { type: 'string', short: 'm', default: 'GET'},
    body: { type: 'string', short: 'b'},
    header: { type: 'string', short: 'H', multiple: true},
    file: {type: 'string', short: 'f'},
    timeout: {type: 'string', short: 't', default: '5000'}
};

function parseHeaders(headerArray) {
    if(!headerArray) { return undefined};

    const headerObj = {};
    for (const h of headerArray){
        const splitIndex = h.indexOf(':');
        if (splitIndex == -1 ){ continue}
        const key = h.slice(0, splitIndex).trim();
        const value = h.slice(splitIndex + 1).trim();
        headerObj[key] = value;
    }
    return headerObj;
}


async function main() {
    const {values} = parseArgs({options})

    try {
        if (!values.url) {
            console.error('\x1b[31mError:\x1b[0m URL is required. Use -u <url>');
            process.exit(1);
        }

        let finalbody = values.body;
        if(values.file) {
            finalbody = fs.readFileSync(values.file, 'utf8');

        }
        const config = {
            url: values.url,
            method: values.method,
            body: finalbody,
            headers: parseHeaders(values.header),
            timeout: parseInt(values.timeout)
    }
        const response = await executeRequest(config);
        console.error(`\x1b[32mStatus: ${response.status}\x1b[0m \x1b[90m(${response.time}ms)\x1b[0m`);        
        if(!response.body){
            process.exit(0);
        }
        for await (const chunk of response.body){
            process.stdout.write(chunk);
        }
        console.log();

    }catch(error){
        if(error.name === 'TimeoutError' || error.name === 'AbortError'){
            console.error(`\x1b[31mError:\x1b[0m Request timed out after ${values.timeout}ms.`)
        }else {
            console.error(`\x1b[31mError:\x1b[0m ${error.message}`)
        }
        console.error(`${error.message}`);
        process.exit(1);
    }
}

main();