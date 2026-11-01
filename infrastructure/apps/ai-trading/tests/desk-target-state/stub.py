import http.server
import os


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if os.environ.get("MODE") == "control":
            self.send_response(200 if self.path == "/gate/mirofish" else 404)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        identity = self.headers.get("Cf-Access-Authenticated-User-Email", "none")
        self.wfile.write(f"{os.environ['BODY']}:{identity}".encode())

    def log_message(self, *_args):
        pass


http.server.HTTPServer(("", int(os.environ["PORT"])), Handler).serve_forever()
