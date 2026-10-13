"""Small standard-library client for AI-Tidu9 provider APIs."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class TiduError(RuntimeError):
    """Raised when the control plane rejects or cannot complete a request."""


@dataclass(frozen=True)
class CapabilityInvocationResult:
    """Bounded result returned by a capability provider."""

    output: Any
    usage: Mapping[str, float] | None = None
    evidence: tuple[str, ...] = ()


class TiduClient:
    """Synchronous API client that keeps control and policy in AI-Tidu9."""

    def __init__(self, endpoint: str, api_key: str | None = None, timeout: float = 30.0):
        if not endpoint.strip():
            raise ValueError("endpoint must not be empty")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout

    def list_providers(self) -> list[dict[str, Any]]:
        """List provider metadata visible to the current identity."""

        payload = self._request("GET", "/v1/ecosystem/providers")
        providers = payload.get("providers")
        if not isinstance(providers, list):
            raise TiduError("response does not contain a providers list")
        return providers

    def invoke_provider(
        self,
        provider_id: str,
        operation: str,
        input_data: Any,
        *,
        tenant_id: str | None = None,
        timeout_ms: int | None = None,
        maximum_output_bytes: int | None = None,
    ) -> CapabilityInvocationResult:
        """Invoke one provider through platform permission and isolation policy."""

        if not provider_id.strip() or not operation.strip():
            raise ValueError("provider_id and operation must not be empty")
        body = {
            "operation": operation,
            "input": input_data,
            "tenantId": tenant_id,
            "timeoutMs": timeout_ms,
            "maximumOutputBytes": maximum_output_bytes,
        }
        payload = self._request(
            "POST",
            f"/v1/ecosystem/providers/{quote(provider_id, safe='')}/invoke",
            body,
        )
        evidence = payload.get("evidence", [])
        usage = payload.get("usage")
        return CapabilityInvocationResult(
            output=payload.get("output"),
            usage=usage if isinstance(usage, dict) else None,
            evidence=tuple(item for item in evidence if isinstance(item, str))
            if isinstance(evidence, list)
            else (),
        )

    def _request(
        self, method: str, path: str, body: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json", "User-Agent": "ai-tidu9-python"}
        data = None
        if self._api_key is not None:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = Request(f"{self._endpoint}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self._timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:2048]
            raise TiduError(f"AI-Tidu9 returned HTTP {error.code}: {detail}") from error
        except (URLError, TimeoutError) as error:
            raise TiduError(f"AI-Tidu9 is unavailable: {error}") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise TiduError("AI-Tidu9 returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise TiduError("AI-Tidu9 response must be a JSON object")
        return payload
