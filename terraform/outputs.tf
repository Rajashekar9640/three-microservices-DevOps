output "ec2_instance_details" {
  description = "Existing EC2 instance information"
  value = {
    instance_id       = data.aws_instance.existing.id
    instance_type     = data.aws_instance.existing.instance_type
    public_ip         = data.aws_instance.existing.public_ip
    private_ip        = data.aws_instance.existing.private_ip
    availability_zone = data.aws_instance.existing.availability_zone
  }
}

output "vpc_details" {
  description = "Existing VPC information"
  value = {
    vpc_id     = data.aws_vpc.existing.id
    cidr_block = data.aws_vpc.existing.cidr_block
  }
}

output "subnet_details" {
  description = "Existing subnet information"
  value = {
    subnet_id         = data.aws_subnet.existing.id
    cidr_block        = data.aws_subnet.existing.cidr_block
    availability_zone = data.aws_subnet.existing.availability_zone
  }
}

output "security_group_details" {
  description = "Existing security group information"
  value = {
    security_group_id = data.aws_security_group.existing.id
    name              = data.aws_security_group.existing.name
    vpc_id            = data.aws_security_group.existing.vpc_id
  }
}

output "ecr_repository_urls" {
  description = "Existing ECR repository URLs"
  value = {
    for name, repository in data.aws_ecr_repository.existing :
    name => repository.repository_url
  }
}
