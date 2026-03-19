#!/usr/bin/env node

const { parseArgs } = require('node:util');
const { executeRequest } = require('../lib/index.js')

const options = {
    url : {type: 'string', short: 'u'},
    method: { type: 'string', short: 'm', default: 'GET'},
    body: { type: 'string', short: 'b'}
};

async function main() {
    
    try {
        const {values} = parseArgs({options})
        if (!values.url) {
            console.error('\x1b[31mError:\x1b[0m URL is required. Use -u <url>');
            process.exit(1);
        }
        const config = {
            url: values.url,
            method: values.method,
            body: values.body
    }
        const response = await executeRequest(config);
        console.log(`${response.status}`)
        console.log(response.body);

    }catch(error){
        console.error(`${error.message}`);
        process.exit(1);
    }
}

main();