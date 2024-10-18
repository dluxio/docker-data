# DOCKER DATA

NFT Rendering and Proof of Brain Indexing for Honeycomb

## Installation

Make any neccesary changes to docker-compose.yml

Run on the same machine as an instance of HoneyComb

Place the following line as modified in the Honeycomb .env
`DATABASE_URL=postgres://postgres:postgres@db:5432/postgres?sslmode=disable`

Install docker and run with docker compose.

Set up DNS to port 3010 by default. 

Example: 

data.dlux.io (Docker Data)
token.dlux.io (Honeycomb)