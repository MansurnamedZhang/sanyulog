FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py store.py pgstore.py storage_crypto.py auth.py ./
COPY static/ ./static/
USER 1000:1000
EXPOSE 8765
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=4)"
CMD ["python", "server.py"]
