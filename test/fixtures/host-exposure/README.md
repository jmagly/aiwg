# Host exposure fixtures

Synthetic ss, iptables-save, ip6tables-save, UFW and narrowed Docker inspect
captures. Documentation-only address ranges represent public and CDN sources;
10.8.0.2 represents a WireGuard address. No host was contacted. The cache has
an all-interface publish, a valid DNAT/FORWARD path, and an INPUT deny. Port
5432 has an unused allow; the CDN range allows all ports; the second SSH rule
is shadowed. IPv6 INPUT accepts while IPv4 restricts it.
