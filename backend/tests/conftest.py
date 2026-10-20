import pytest

from eventlab.engine import Engine
from eventlab.store import Store


class Clock:
    def __init__(self):
        self.now = 1800000000.0

    def __call__(self):
        return self.now

    def advance(self, seconds=1):
        self.now += seconds


@pytest.fixture
def lab(tmp_path):
    clock = Clock()
    engine = Engine(Store(str(tmp_path / "lab.db")), clock=clock)
    return engine, clock


def drain(engine, clock, steps=40):
    for _ in range(steps):
        engine.tick()
        clock.advance()
