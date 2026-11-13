# The fixture's server: an ordinary FastAPI app, sync and async endpoints,
# importing a package no browser has (psycopg2) that it only uses when
# configured.
import os

import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from logic.rooms import ROOMS, new_room

app = FastAPI()
DB = psycopg2.connect(os.environ["DATABASE_URL"]) if os.environ.get("DATABASE_URL") else None


class Click(BaseModel):
    room: str


@app.get("/hello")
def hello():
    return {"text": "hello from python"}


@app.post("/rooms")
def rooms():
    return {"id": new_room()}


@app.post("/click")
def click(c: Click):
    if c.room not in ROOMS:
        raise HTTPException(404)
    ROOMS[c.room] += 1
    return {"count": ROOMS[c.room]}


@app.get("/state")
async def state(room: str):
    if room not in ROOMS:
        raise HTTPException(404)
    return {"count": ROOMS[room]}


@app.get("/leak")
async def leak():
    """Try to reach the internet from Python: the frame must refuse."""
    try:
        from js import fetch

        r = await fetch("https://example.com/")
        return {"status": r.status}
    except Exception as err:
        return {"error": type(err).__name__}
