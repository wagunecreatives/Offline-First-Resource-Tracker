FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Copy requirements from the nested folder
COPY clinic-tracker/server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy both server and client folders
COPY clinic-tracker/server/ /app/server/
COPY clinic-tracker/client/ /app/client/

WORKDIR /app/server

EXPOSE 5000

CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]