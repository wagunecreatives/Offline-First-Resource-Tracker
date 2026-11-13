FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Set working directory
WORKDIR /app

# Install dependencies first (leverages Docker cache if code changes but requirements don't)
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the server and client directories into the container
COPY server/ /app/server/
COPY client/ /app/client/

# Set the working directory to the server folder where app.py lives
WORKDIR /app/server

# Expose the application port
EXPOSE 5000

# Start the application using Gunicorn
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]