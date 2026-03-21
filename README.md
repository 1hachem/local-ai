
Example when running the server in tcp mode

```bash
echo "hello hi" | nc localhost 3005
```

Example when running in socket mode

```bash
echo "hello hi" | nc -U /tmp/local-ai.socket
```
