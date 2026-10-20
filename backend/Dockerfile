FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock \
    && useradd --create-home --uid 10001 eventlab \
    && mkdir -p /app/data && chown eventlab:eventlab /app/data
COPY eventlab ./eventlab
USER eventlab
EXPOSE 8000
CMD ["uvicorn", "eventlab.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
