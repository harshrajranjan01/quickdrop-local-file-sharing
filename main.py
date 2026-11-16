"""QuickDrop entry point. Run with ``python main.py``."""

import os

import uvicorn

from quickdrop.server import create_app


app = create_app()


if __name__ == "__main__":
    cert = os.getenv("QUICKDROP_TLS_CERT")
    key = os.getenv("QUICKDROP_TLS_KEY")
    uvicorn.run(
        app,
        host=os.getenv("QUICKDROP_HOST", "0.0.0.0"),
        port=int(os.getenv("QUICKDROP_PORT", "8000")),
        ssl_certfile=cert or None,
        ssl_keyfile=key or None,
        log_level="info",
    )
