import uuid

ROOMS = {}


def new_room():
    rid = uuid.uuid4().hex[:8]
    ROOMS[rid] = 0
    return rid
