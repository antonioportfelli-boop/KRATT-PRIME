// Experimental CO-RE XDP telemetry specimen. Always passes packets unchanged.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_core_read.h>

#define ETH_P_IP 0x0800
#define ETH_P_IPV6 0x86DD
#define IPPROTO_TCP 6
#define IPPROTO_UDP 17
#define STAT_TOTAL 0
#define STAT_IPV4 1
#define STAT_IPV6 2
#define STAT_PARSE_ERROR 3
#define STAT_UNSUPPORTED 4
#define STAT_RINGBUF_LOSS 5

struct packet_event {
    __u64 ts_ns;
    __u8 proto;
    __u8 ip_version;
    __u8 pad[2];
    __u8 saddr[16];
    __u8 daddr[16];
    __u16 sport;
    __u16 dport;
    __u32 pkt_len;
};

struct config_t {
    __u32 version;
    __u32 sampling_rate; /* Reserved: not applied by this initial parser. */
    __u16 monitor_port;  /* Reserved: not applied by this initial parser. */
    __u16 flags;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 8);
    __type(key, __u32);
    __type(value, __u64);
} stats SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct config_t);
} global_config SEC(".maps");

static __always_inline void count_stat(__u32 key)
{
    __u64 *value = bpf_map_lookup_elem(&stats, &key);
    if (value)
        *value += 1; /* Per-CPU map: no cross-CPU atomic operation required. */
}

static __always_inline int parse_l4(void *hdr, void *data_end, __u8 proto,
                                    __u16 *sport, __u16 *dport)
{
    if (proto == IPPROTO_TCP) {
        struct tcphdr *tcp = hdr;
        if ((void *)(tcp + 1) > data_end)
            return -1;
        *sport = bpf_ntohs(tcp->source);
        *dport = bpf_ntohs(tcp->dest);
        return 0;
    }
    if (proto == IPPROTO_UDP) {
        struct udphdr *udp = hdr;
        if ((void *)(udp + 1) > data_end)
            return -1;
        *sport = bpf_ntohs(udp->source);
        *dport = bpf_ntohs(udp->dest);
        return 0;
    }
    *sport = 0;
    *dport = 0;
    return 0;
}

SEC("xdp")
int goliath_ingress_telemetry(struct xdp_md *ctx)
{
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;
    struct ethhdr *eth = data;
    struct packet_event event = {};
    __u16 eth_type;

    if ((void *)(eth + 1) > data_end) {
        count_stat(STAT_PARSE_ERROR);
        return XDP_PASS;
    }

    eth_type = bpf_ntohs(eth->h_proto);
    event.ts_ns = bpf_ktime_get_ns();
    event.pkt_len = (__u32)((char *)data_end - (char *)data);

    if (eth_type == ETH_P_IP) {
        struct iphdr *iph = (void *)(eth + 1);
        __u32 ihl_len;
        __u16 frag_off;

        if ((void *)(iph + 1) > data_end || iph->version != 4 || iph->ihl < 5) {
            count_stat(STAT_PARSE_ERROR);
            return XDP_PASS;
        }
        ihl_len = (__u32)iph->ihl * 4;
        if ((void *)iph + ihl_len > data_end) {
            count_stat(STAT_PARSE_ERROR);
            return XDP_PASS;
        }
        frag_off = bpf_ntohs(iph->frag_off);
        if (frag_off & 0x1FFF) {
            count_stat(STAT_UNSUPPORTED); /* Non-first fragment: no L4 ports. */
            return XDP_PASS;
        }

        event.ip_version = 4;
        event.proto = iph->protocol;
        __builtin_memcpy(event.saddr, &iph->saddr, sizeof(iph->saddr));
        __builtin_memcpy(event.daddr, &iph->daddr, sizeof(iph->daddr));
        if (parse_l4((void *)iph + ihl_len, data_end, iph->protocol,
                     &event.sport, &event.dport) < 0) {
            count_stat(STAT_PARSE_ERROR);
            return XDP_PASS;
        }
        count_stat(STAT_IPV4);
    } else if (eth_type == ETH_P_IPV6) {
        struct ipv6hdr *ip6h = (void *)(eth + 1);

        if ((void *)(ip6h + 1) > data_end || ip6h->version != 6) {
            count_stat(STAT_PARSE_ERROR);
            return XDP_PASS;
        }
        /* First slice supports only direct TCP/UDP next-header values.
         * Extension headers and fragments are passed without event decoding. */
        if (ip6h->nexthdr != IPPROTO_TCP && ip6h->nexthdr != IPPROTO_UDP) {
            count_stat(STAT_UNSUPPORTED);
            return XDP_PASS;
        }
        event.ip_version = 6;
        event.proto = ip6h->nexthdr;
        __builtin_memcpy(event.saddr, &ip6h->saddr, sizeof(ip6h->saddr));
        __builtin_memcpy(event.daddr, &ip6h->daddr, sizeof(ip6h->daddr));
        if (parse_l4((void *)(ip6h + 1), data_end, ip6h->nexthdr,
                     &event.sport, &event.dport) < 0) {
            count_stat(STAT_PARSE_ERROR);
            return XDP_PASS;
        }
        count_stat(STAT_IPV6);
    } else {
        count_stat(STAT_UNSUPPORTED);
        return XDP_PASS;
    }

    count_stat(STAT_TOTAL);
    if (bpf_ringbuf_output(&events, &event, sizeof(event), 0) < 0)
        count_stat(STAT_RINGBUF_LOSS);

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
