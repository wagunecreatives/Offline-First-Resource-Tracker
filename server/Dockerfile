FROM python:3.11-slim

WORKDIR /app

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ /app/server/
COPY client/ /app/client/

WORKDIR /app/server

ENV PYTHONUNBUFFERED=1
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]